import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runTenantMigrations } from "../../../infrastructure/database/tenant/migrate.js";
import * as tenantSchema from "../../../infrastructure/database/tenant/schema.js";
import { createDrizzlePropertyMediaRepository } from "../../properties/infrastructure/drizzle-property-media-repository.js";
import { createDrizzlePropertyRepository } from "../../properties/infrastructure/drizzle-property-repository.js";
import { createDrizzlePropertyMediaProcessingRepository } from "./drizzle-property-media-processing-repository.js";

/** Real `postgres-tenants` (Docker Compose), never mocked — same convention as
 * `drizzle-property-media-repository.test.ts`. */
const HOST = "localhost";
const PORT = 5433;
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";

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

async function createMigratedTenantDatabase() {
  const databaseName = `media_processing_repo_test_${randomUUID().replaceAll("-", "")}`;
  await withAdminClient((client) => client.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`));

  await runTenantMigrations({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  const pool = new Pool({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  createdFixtures.push({ databaseName, pool });

  return drizzle(pool, { schema: tenantSchema });
}

/** Real upload (Prompt 027/030) — property_media + outbox_event created atomically, exactly the
 * shape the worker will actually see in production. */
async function createRealPendingMedia(db: Awaited<ReturnType<typeof createMigratedTenantDatabase>>) {
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
  const media = await mediaRepository.create({
    id: mediaId,
    propertyId: property.id,
    objectKey: `tenants/t/properties/${property.id}/${mediaId}.jpg`,
    publicUrl: `https://public-base.example/tenants/t/properties/${property.id}/${mediaId}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 12345,
    originalFilename: "foto.jpg",
  });

  const [event] = await db
    .select()
    .from(tenantSchema.outboxEvents)
    .where(eq(tenantSchema.outboxEvents.aggregateId, media.id));
  if (!event) {
    throw new Error("expected an outbox event to have been created alongside the media");
  }

  return { property, media, outboxEventId: event.id };
}

function sampleUploadedVariant(variant: "THUMBNAIL" | "CARD" | "DETAIL", mediaId: string) {
  return {
    variant,
    objectKey: `tenants/t/properties/p/${mediaId}/${variant.toLowerCase()}.webp`,
    publicUrl: `https://public-base.example/tenants/t/properties/p/${mediaId}/${variant.toLowerCase()}.webp`,
    mimeType: "image/webp",
    width: 320,
    height: 240,
    sizeBytes: 4096,
  };
}

describe("createDrizzlePropertyMediaProcessingRepository — loadContext", () => {
  it("returns ready with the original's object_key/mime_type for a valid pending event", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { property, media, outboxEventId } = await createRealPendingMedia(db);

    const result = await repository.loadContext({ outboxEventId, propertyId: property.id, mediaId: media.id });

    expect(result).toEqual({
      outcome: "ready",
      context: { mediaId: media.id, propertyId: property.id, objectKey: media.objectKey, mimeType: "image/jpeg" },
    });
  });

  it("returns already-processed when the outbox event's processed_at is already set", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { property, media, outboxEventId } = await createRealPendingMedia(db);
    await db.update(tenantSchema.outboxEvents).set({ processedAt: sql`now()` }).where(eq(tenantSchema.outboxEvents.id, outboxEventId));

    const result = await repository.loadContext({ outboxEventId, propertyId: property.id, mediaId: media.id });

    expect(result).toEqual({ outcome: "already-processed" });
  });

  it("returns media-missing when property_media no longer exists", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { property, media, outboxEventId } = await createRealPendingMedia(db);
    await db.delete(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));

    const result = await repository.loadContext({ outboxEventId, propertyId: property.id, mediaId: media.id });

    expect(result).toEqual({ outcome: "media-missing" });
  });

  it("returns invalid-event when the outbox event id does not exist at all", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { property, media } = await createRealPendingMedia(db);

    const result = await repository.loadContext({ outboxEventId: randomUUID(), propertyId: property.id, mediaId: media.id });

    expect(result).toEqual({ outcome: "invalid-event" });
  });

  it("returns invalid-event when the media belongs to a different property than the payload claims", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { media, outboxEventId } = await createRealPendingMedia(db);

    const result = await repository.loadContext({ outboxEventId, propertyId: randomUUID(), mediaId: media.id });

    expect(result).toEqual({ outcome: "invalid-event" });
  });
});

describe("createDrizzlePropertyMediaProcessingRepository — markObsoleteProcessed", () => {
  it("marks the outbox event processed without touching property_media", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { outboxEventId } = await createRealPendingMedia(db);

    await repository.markObsoleteProcessed(outboxEventId);

    const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, outboxEventId));
    expect(event?.processedAt).toBeInstanceOf(Date);
  });
});

describe("createDrizzlePropertyMediaProcessingRepository — finalizeReady", () => {
  it("upserts all three variants, sets processing_status READY, and marks the outbox event processed atomically", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { media, outboxEventId } = await createRealPendingMedia(db);
    const variants = [
      sampleUploadedVariant("THUMBNAIL", media.id),
      sampleUploadedVariant("CARD", media.id),
      sampleUploadedVariant("DETAIL", media.id),
    ];

    const result = await repository.finalizeReady({ outboxEventId, mediaId: media.id, variants });

    expect(result).toBe("finalized");
    const storedVariants = await db
      .select()
      .from(tenantSchema.propertyMediaVariants)
      .where(eq(tenantSchema.propertyMediaVariants.propertyMediaId, media.id));
    expect(storedVariants.map((v) => v.variant).sort()).toEqual(["CARD", "DETAIL", "THUMBNAIL"]);

    const [updatedMedia] = await db.select().from(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));
    expect(updatedMedia?.processingStatus).toBe("READY");

    const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, outboxEventId));
    expect(event?.processedAt).toBeInstanceOf(Date);
  });

  it("retrying finalizeReady for the same media converges to exactly one row per variant (upsert, no duplicates)", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { media, outboxEventId } = await createRealPendingMedia(db);
    const variants = [
      sampleUploadedVariant("THUMBNAIL", media.id),
      sampleUploadedVariant("CARD", media.id),
      sampleUploadedVariant("DETAIL", media.id),
    ];

    await repository.finalizeReady({ outboxEventId, mediaId: media.id, variants });
    // A second finalize call for the same media — simulates a redelivered/retried job after
    // the first one already fully succeeded.
    await repository.finalizeReady({ outboxEventId, mediaId: media.id, variants });

    const storedVariants = await db
      .select()
      .from(tenantSchema.propertyMediaVariants)
      .where(eq(tenantSchema.propertyMediaVariants.propertyMediaId, media.id));
    expect(storedVariants).toHaveLength(3);
  });

  it("returns media-missing and marks the outbox event processed when the media was deleted before finalize", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { media, outboxEventId } = await createRealPendingMedia(db);
    await db.delete(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));

    const result = await repository.finalizeReady({
      outboxEventId,
      mediaId: media.id,
      variants: [sampleUploadedVariant("THUMBNAIL", media.id)],
    });

    expect(result).toBe("media-missing");
    const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, outboxEventId));
    expect(event?.processedAt).toBeInstanceOf(Date);
    const storedVariants = await db
      .select()
      .from(tenantSchema.propertyMediaVariants)
      .where(eq(tenantSchema.propertyMediaVariants.propertyMediaId, media.id));
    expect(storedVariants).toHaveLength(0);
  });

  it("rolls back the entire transaction — no READY, no processed_at, no partial variants — when a variant write fails mid-way", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { media: mediaA, outboxEventId } = await createRealPendingMedia(db);
    const { media: mediaB } = await createRealPendingMedia(db);
    // A variant for mediaB already occupies this exact object_key — object_key is UNIQUE across
    // the whole table, so inserting a second row with the same key (for mediaA) fails partway
    // through the loop, forcing the entire transaction to roll back.
    const collidingKey = `tenants/t/properties/p/${mediaB.id}/thumbnail.webp`;
    await db.insert(tenantSchema.propertyMediaVariants).values({
      propertyMediaId: mediaB.id,
      variant: "THUMBNAIL",
      objectKey: collidingKey,
      publicUrl: "https://public-base.example/existing.webp",
      mimeType: "image/webp",
      width: 320,
      height: 240,
      sizeBytes: 4096,
    });

    await expect(
      repository.finalizeReady({
        outboxEventId,
        mediaId: mediaA.id,
        variants: [
          { ...sampleUploadedVariant("THUMBNAIL", mediaA.id), objectKey: collidingKey },
          sampleUploadedVariant("CARD", mediaA.id),
        ],
      }),
    ).rejects.toThrow();

    const storedVariantsForA = await db
      .select()
      .from(tenantSchema.propertyMediaVariants)
      .where(eq(tenantSchema.propertyMediaVariants.propertyMediaId, mediaA.id));
    expect(storedVariantsForA).toHaveLength(0);

    const [updatedMediaA] = await db.select().from(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, mediaA.id));
    expect(updatedMediaA?.processingStatus).toBe("PROCESSING");

    const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, outboxEventId));
    expect(event?.processedAt).toBeNull();
  });
});

describe("createDrizzlePropertyMediaProcessingRepository — finalizeFailed", () => {
  it("sets processing_status FAILED and marks the outbox event processed, creating no variant rows", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { media, outboxEventId } = await createRealPendingMedia(db);

    const result = await repository.finalizeFailed({ outboxEventId, mediaId: media.id });

    expect(result).toBe("finalized");
    const [updatedMedia] = await db.select().from(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));
    expect(updatedMedia?.processingStatus).toBe("FAILED");
    const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, outboxEventId));
    expect(event?.processedAt).toBeInstanceOf(Date);
    const storedVariants = await db
      .select()
      .from(tenantSchema.propertyMediaVariants)
      .where(eq(tenantSchema.propertyMediaVariants.propertyMediaId, media.id));
    expect(storedVariants).toHaveLength(0);
  });

  it("returns media-missing and marks the outbox event processed when the media was already deleted", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    const { media, outboxEventId } = await createRealPendingMedia(db);
    await db.delete(tenantSchema.propertyMedia).where(eq(tenantSchema.propertyMedia.id, media.id));

    const result = await repository.finalizeFailed({ outboxEventId, mediaId: media.id });

    expect(result).toBe("media-missing");
    const [event] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, outboxEventId));
    expect(event?.processedAt).toBeInstanceOf(Date);
  });
});
