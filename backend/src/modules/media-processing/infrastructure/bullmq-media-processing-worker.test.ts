import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runTenantMigrations } from "../../../infrastructure/database/tenant/migrate.js";
import * as tenantSchema from "../../../infrastructure/database/tenant/schema.js";
import type { ObjectStorage } from "../../../infrastructure/object-storage/object-storage.js";
import { createInMemoryObjectStorage, type InMemoryObjectStorage } from "../../../infrastructure/object-storage/test-support/in-memory-object-storage.js";
import { createMediaProcessingQueue, PROCESS_PROPERTY_MEDIA_JOB_NAME, type MediaProcessingQueue } from "../../../infrastructure/queue/media-processing-queue.js";
import { createRedisConnection } from "../../../infrastructure/queue/redis-connection.js";
import { createDrizzlePropertyMediaRepository } from "../../properties/infrastructure/drizzle-property-media-repository.js";
import { createDrizzlePropertyRepository } from "../../properties/infrastructure/drizzle-property-repository.js";
import type { TenantDatabase, TenantDatabaseConnectionManager } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { TenantDatabaseResolver, TenantDatabaseTarget } from "../../tenant-runtime/application/tenant-database-resolver.js";
import { createSharpImageVariantProcessor } from "./sharp-image-variant-processor.js";
import { createMediaProcessingWorker } from "./bullmq-media-processing-worker.js";

/**
 * Real PostgreSQL (Tenant Data Plane) + real Redis/BullMQ + real `sharp` throughout (this task,
 * sections 80-83) — an in-memory `ObjectStorage` stands in only for Cloudflare R2 itself (no
 * external network dependency for an automated suite), never for anything that determines
 * job/idempotency/finalization behavior. `TenantDatabaseResolver`/`TenantDatabaseConnectionManager`
 * are lightweight fakes that hand back the one real tenant database created per test — this
 * suite is about the worker's own consume/process/finalize behavior, not Control Plane tenant
 * discovery (already covered by `drizzle-tenant-discovery.test.ts`/the dispatcher's own tests).
 */
const HOST = "localhost";
const PORT = 5433;
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ host: HOST, port: PORT, database: "postgres", user: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const createdFixtures: { databaseName: string; pool: Pool }[] = [];

afterEach(async () => {
  const fixtures = createdFixtures.splice(0, createdFixtures.length);
  for (const fixture of fixtures) {
    await fixture.pool.end();
  }
  await withAdminClient(async (client) => {
    for (const fixture of fixtures) {
      await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(fixture.databaseName)} WITH (FORCE)`);
    }
  });
});

async function createMigratedTenantDatabase(): Promise<TenantDatabase> {
  const databaseName = `media_processing_worker_test_${randomUUID().replaceAll("-", "")}`;
  await withAdminClient((client) => client.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`));

  await runTenantMigrations({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  const pool = new Pool({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  createdFixtures.push({ databaseName, pool });

  return drizzle(pool, { schema: tenantSchema });
}

function fakeTenantDatabaseResolver(target: TenantDatabaseTarget): TenantDatabaseResolver {
  return { resolve: async () => target };
}

function fakeTenantDatabaseConnectionManager(db: TenantDatabase): TenantDatabaseConnectionManager {
  return {
    withTenantDatabase: async (_target, operation) => operation(db),
    invalidate: async () => undefined,
    close: async () => undefined,
  };
}

function fakeTarget(): TenantDatabaseTarget {
  return {
    tenantId: TENANT_ID,
    clusterId: "cluster-1",
    host: HOST,
    port: PORT,
    databaseName: "unused",
    secretReference: "unused",
    schemaVersion: 1,
  };
}

/** Real upload path (Prompt 027/030) — property_media + outbox_event created atomically. The
 * original's real bytes are also placed into the given `ObjectStorage` under the same key, so
 * the worker's real download+`sharp` pipeline has something genuine to process. */
async function createRealPendingMedia(
  db: TenantDatabase,
  objectStorage: InMemoryObjectStorage,
  originalBytes: Buffer,
) {
  const propertyRepository = createDrizzlePropertyRepository(db);
  const mediaRepository = createDrizzlePropertyMediaRepository(db);
  const property = await propertyRepository.create({
    title: "Apartamento no Centro",
    description: null,
    propertyType: "APARTMENT",
    transactionType: "SALE",
    status: "ACTIVE",
    price: "450000.00",
    bedrooms: null,
    bathrooms: null,
    parkingSpaces: null,
    areaM2: null,
    street: null,
    number: null,
    complement: null,
    neighborhood: null,
    city: null,
    state: null,
    postalCode: null,
  });
  const mediaId = randomUUID();
  const objectKey = `tenants/${TENANT_ID}/properties/${property.id}/${mediaId}.jpg`;
  await objectStorage.putObject({ key: objectKey, body: originalBytes, contentType: "image/jpeg" });
  const media = await mediaRepository.create({
    id: mediaId,
    propertyId: property.id,
    objectKey,
    publicUrl: `https://public-base.example/${objectKey}`,
    mimeType: "image/jpeg",
    sizeBytes: originalBytes.length,
    originalFilename: "foto.jpg",
  });

  const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.aggregateId, media.id));
  if (!event) {
    throw new Error("expected an outbox event to have been created alongside the media");
  }

  return { property, media, outboxEventId: event.id };
}

async function buildRealJpeg(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } } }).jpeg().toBuffer();
}

function waitForJobSettled(worker: ReturnType<typeof createMediaProcessingWorker>, jobId: string, timeoutMs = 15_000): Promise<"completed" | "failed"> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for job to settle")), timeoutMs);
    worker.on("completed", (job) => {
      if (job.id === jobId) {
        clearTimeout(timeout);
        resolve("completed");
      }
    });
    worker.on("failed", (job) => {
      if (job?.id === jobId && (job.attemptsMade >= (job.opts.attempts ?? 1))) {
        clearTimeout(timeout);
        resolve("failed");
      }
    });
  });
}

interface TestHarness {
  connection: ReturnType<typeof createRedisConnection>;
  workerConnection: ReturnType<typeof createRedisConnection>;
  queue: MediaProcessingQueue;
  worker: ReturnType<typeof createMediaProcessingWorker>;
}

async function buildHarness(
  db: TenantDatabase,
  objectStorage: ObjectStorage,
  options: { attempts?: number; backoffDelayMs?: number; concurrency?: number } = {},
): Promise<TestHarness> {
  const connection = createRedisConnection();
  const queue = createMediaProcessingQueue(connection, {
    attempts: options.attempts ?? 1,
    backoffDelayMs: options.backoffDelayMs ?? 50,
  });
  const workerConnection = createRedisConnection();
  const worker = createMediaProcessingWorker(workerConnection, {
    tenantDatabaseResolver: fakeTenantDatabaseResolver(fakeTarget()),
    tenantDatabaseConnectionManager: fakeTenantDatabaseConnectionManager(db),
    objectStorage,
    imageVariantProcessor: createSharpImageVariantProcessor({ maxInputPixels: 40_000_000 }),
    concurrency: options.concurrency ?? 2,
  });
  return { connection, workerConnection, queue, worker };
}

async function teardownHarness(harness: TestHarness): Promise<void> {
  await harness.worker.close();
  await harness.queue.obliterate({ force: true }).catch(() => undefined);
  await harness.queue.close();
  await harness.connection.quit();
  await harness.workerConnection.quit();
}

describe("createMediaProcessingWorker (real Redis + PostgreSQL + sharp)", () => {
  it("PROCESSING → READY: generates and persists all three variants for a real upload", async () => {
    const db = await createMigratedTenantDatabase();
    const objectStorage = createInMemoryObjectStorage();
    const originalBytes = await buildRealJpeg(1600, 1200);
    const { media, outboxEventId } = await createRealPendingMedia(db, objectStorage, originalBytes);

    const harness = await buildHarness(db, objectStorage);
    try {
      await harness.queue.add(
        PROCESS_PROPERTY_MEDIA_JOB_NAME,
        { tenantId: TENANT_ID, propertyId: media.propertyId, mediaId: media.id },
        { jobId: outboxEventId },
      );

      const outcome = await waitForJobSettled(harness.worker, outboxEventId);
      expect(outcome).toBe("completed");

      const [updatedMedia] = await db.select().from(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));
      expect(updatedMedia?.processingStatus).toBe("READY");

      const variants = await db.select().from(tenantSchema.propertyMediaVariants).where(eq(tenantSchema.propertyMediaVariants.propertyMediaId, media.id));
      expect(variants.map((v) => v.variant).sort()).toEqual(["CARD", "DETAIL", "THUMBNAIL"]);
      for (const variant of variants) {
        expect(variant.mimeType).toBe("image/webp");
        expect(objectStorage.has(variant.objectKey)).toBe(true);
      }

      const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, outboxEventId));
      expect(event?.processedAt).toBeInstanceOf(Date);
    } finally {
      await teardownHarness(harness);
    }
  }, 20_000);

  it("permanent failure: an undecodable original ends the media as FAILED, outbox processed, no variants", async () => {
    const db = await createMigratedTenantDatabase();
    const objectStorage = createInMemoryObjectStorage();
    const garbageBytes = Buffer.from("this is not a real image, sharp cannot decode it");
    const { media, outboxEventId } = await createRealPendingMedia(db, objectStorage, garbageBytes);

    const harness = await buildHarness(db, objectStorage);
    try {
      await harness.queue.add(
        PROCESS_PROPERTY_MEDIA_JOB_NAME,
        { tenantId: TENANT_ID, propertyId: media.propertyId, mediaId: media.id },
        { jobId: outboxEventId },
      );

      // Permanent failures resolve via UnrecoverableError, which BullMQ treats as an immediate,
      // one-shot failure regardless of configured attempts.
      const outcome = await waitForJobSettled(harness.worker, outboxEventId);
      expect(outcome).toBe("failed");

      const [updatedMedia] = await db.select().from(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));
      expect(updatedMedia?.processingStatus).toBe("FAILED");

      const variants = await db.select().from(tenantSchema.propertyMediaVariants).where(eq(tenantSchema.propertyMediaVariants.propertyMediaId, media.id));
      expect(variants).toHaveLength(0);

      const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, outboxEventId));
      expect(event?.processedAt).toBeInstanceOf(Date);
    } finally {
      await teardownHarness(harness);
    }
  }, 20_000);

  it("transient failure then recovery: retries and converges to READY", async () => {
    const db = await createMigratedTenantDatabase();
    const realObjectStorage = createInMemoryObjectStorage();
    const originalBytes = await buildRealJpeg(800, 600);
    const { media, outboxEventId } = await createRealPendingMedia(db, realObjectStorage, originalBytes);

    let getObjectCalls = 0;
    const flakyObjectStorage: ObjectStorage = {
      ...realObjectStorage,
      async getObject(key) {
        getObjectCalls += 1;
        if (getObjectCalls === 1) {
          throw new Error("simulated transient R2 failure");
        }
        return realObjectStorage.getObject(key);
      },
    };

    const harness = await buildHarness(db, flakyObjectStorage, { attempts: 3, backoffDelayMs: 50 });
    try {
      await harness.queue.add(
        PROCESS_PROPERTY_MEDIA_JOB_NAME,
        { tenantId: TENANT_ID, propertyId: media.propertyId, mediaId: media.id },
        { jobId: outboxEventId },
      );

      const outcome = await waitForJobSettled(harness.worker, outboxEventId);
      expect(outcome).toBe("completed");
      expect(getObjectCalls).toBeGreaterThanOrEqual(2);

      const [updatedMedia] = await db.select().from(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));
      expect(updatedMedia?.processingStatus).toBe("READY");
    } finally {
      await teardownHarness(harness);
    }
  }, 20_000);

  it("retry exhaustion: a persistently transient failure ends the media as FAILED once attempts run out", async () => {
    const db = await createMigratedTenantDatabase();
    const realObjectStorage = createInMemoryObjectStorage();
    const originalBytes = await buildRealJpeg(400, 300);
    const { media, outboxEventId } = await createRealPendingMedia(db, realObjectStorage, originalBytes);

    const alwaysFailingObjectStorage: ObjectStorage = {
      ...realObjectStorage,
      async getObject() {
        throw new Error("R2 permanently unreachable in this test");
      },
    };

    const harness = await buildHarness(db, alwaysFailingObjectStorage, { attempts: 2, backoffDelayMs: 50 });
    try {
      await harness.queue.add(
        PROCESS_PROPERTY_MEDIA_JOB_NAME,
        { tenantId: TENANT_ID, propertyId: media.propertyId, mediaId: media.id },
        { jobId: outboxEventId },
      );

      const outcome = await waitForJobSettled(harness.worker, outboxEventId);
      expect(outcome).toBe("failed");

      const [updatedMedia] = await db.select().from(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));
      expect(updatedMedia?.processingStatus).toBe("FAILED");

      const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, outboxEventId));
      expect(event?.processedAt).toBeInstanceOf(Date);
    } finally {
      await teardownHarness(harness);
    }
  }, 20_000);

  it("missing media: a job for an already-deleted media marks the outbox processed, creates no FAILED media, no variants", async () => {
    const db = await createMigratedTenantDatabase();
    const objectStorage = createInMemoryObjectStorage();
    const originalBytes = await buildRealJpeg(400, 300);
    const { property, media, outboxEventId } = await createRealPendingMedia(db, objectStorage, originalBytes);
    // Simulates the media having been deleted (Prompt 028's DELETE .../media/:id) after the
    // outbox event was enqueued but before the worker ever picks it up.
    await db.delete(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));

    const harness = await buildHarness(db, objectStorage);
    try {
      await harness.queue.add(
        PROCESS_PROPERTY_MEDIA_JOB_NAME,
        { tenantId: TENANT_ID, propertyId: property.id, mediaId: media.id },
        { jobId: outboxEventId },
      );

      const outcome = await waitForJobSettled(harness.worker, outboxEventId);
      expect(outcome).toBe("completed");

      const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, outboxEventId));
      expect(event?.processedAt).toBeInstanceOf(Date);

      const remainingMedia = await db.select().from(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));
      expect(remainingMedia).toHaveLength(0);
      const variants = await db.select().from(tenantSchema.propertyMediaVariants).where(eq(tenantSchema.propertyMediaVariants.propertyMediaId, media.id));
      expect(variants).toHaveLength(0);
    } finally {
      await teardownHarness(harness);
    }
  }, 20_000);
});
