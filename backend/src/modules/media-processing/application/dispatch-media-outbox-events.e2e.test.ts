import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, escapeIdentifier } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTenantMigrations } from "../../../infrastructure/database/tenant/migrate.js";
import * as tenantSchema from "../../../infrastructure/database/tenant/schema.js";
import { createMediaProcessingQueue, type MediaProcessingQueue } from "../../../infrastructure/queue/media-processing-queue.js";
import { createRedisConnection } from "../../../infrastructure/queue/redis-connection.js";
import {
  PROPERTY_MEDIA_AGGREGATE_TYPE,
  PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE,
} from "../../properties/domain/property-media-processing-event.js";
import { createBullMqMediaOutboxJobPublisher } from "../infrastructure/bullmq-media-outbox-job-publisher.js";
import { createDrizzleMediaOutboxDispatchRepository } from "../infrastructure/drizzle-media-outbox-dispatch-repository.js";
import { dispatchTenantMediaOutboxOnce } from "./dispatch-media-outbox-events.js";
import type { MediaOutboxDispatchRepository } from "./dispatch-media-outbox-events.js";

/**
 * Real PostgreSQL (Tenant Data Plane) + real Redis/BullMQ throughout — the "crash window" this
 * task asks to prove (section 17/59) is specifically about real jobId-based idempotency, which
 * a mocked queue could not demonstrate.
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

async function createMigratedTenantDatabase() {
  const databaseName = `media_outbox_events_e2e_${randomUUID().replaceAll("-", "")}`;
  await withAdminClient((client) => client.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`));

  await runTenantMigrations({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  const pool = new Pool({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  createdFixtures.push({ databaseName, pool });

  return drizzle(pool, { schema: tenantSchema });
}

async function insertOutboxEvent(db: Awaited<ReturnType<typeof createMigratedTenantDatabase>>) {
  const [row] = await db
    .insert(tenantSchema.outboxEvents)
    .values({
      aggregateType: PROPERTY_MEDIA_AGGREGATE_TYPE,
      aggregateId: randomUUID(),
      eventType: PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE,
      payload: { propertyId: randomUUID(), mediaId: randomUUID() },
      occurredAt: new Date(),
    })
    .returning();
  if (!row) {
    throw new Error("outbox_events insert returned no row");
  }
  return row;
}

let connection: ReturnType<typeof createRedisConnection>;
let queue: MediaProcessingQueue;

beforeEach(() => {
  connection = createRedisConnection();
  queue = createMediaProcessingQueue(connection, { attempts: 5, backoffDelayMs: 5000 });
});

afterEach(async () => {
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await connection.quit();
});

describe("dispatchTenantMediaOutboxOnce — crash window (real PostgreSQL + real Redis)", () => {
  it("a queue.add success followed by a confirmation failure never creates a duplicate job on retry", async () => {
    const db = await createMigratedTenantDatabase();
    const event = await insertOutboxEvent(db);
    const realRepository = createDrizzleMediaOutboxDispatchRepository(db);
    const publisher = createBullMqMediaOutboxJobPublisher(queue);

    // Simulates the exact crash window this task describes: queue.add() (inside publish())
    // resolves successfully, but the confirmation write to PostgreSQL fails on the very next
    // step. Every other repository method is the real, unmodified implementation.
    let markDispatchedAttempts = 0;
    const flakyRepository: MediaOutboxDispatchRepository = {
      ...realRepository,
      async markDispatched(outboxEventId: string): Promise<void> {
        markDispatchedAttempts += 1;
        if (markDispatchedAttempts === 1) {
          throw new Error("simulated PostgreSQL confirmation failure");
        }
        return realRepository.markDispatched(outboxEventId);
      },
    };

    const firstAttempt = await dispatchTenantMediaOutboxOnce(TENANT_ID, flakyRepository, publisher, {
      batchSize: 10,
      leaseSeconds: 30,
    });
    expect(firstAttempt.results).toEqual([{ outboxEventId: event.id, outcome: "failed", error: expect.any(Error) }]);

    // The job genuinely reached Redis despite the confirmation failure.
    const jobAfterFirstAttempt = await queue.getJob(event.id);
    expect(jobAfterFirstAttempt).toBeDefined();

    // The lease was released (dispatchTenantMediaOutboxOnce's own failure path) — the event is
    // claimable again, exactly as a fresh dispatch cycle would find it.
    const secondAttempt = await dispatchTenantMediaOutboxOnce(TENANT_ID, flakyRepository, publisher, {
      batchSize: 10,
      leaseSeconds: 30,
    });
    expect(secondAttempt.results).toEqual([{ outboxEventId: event.id, outcome: "dispatched" }]);

    // Two publish() calls happened (once per attempt, both with jobId = event.id) — BullMQ must
    // have converged them into exactly one logical job, never two.
    const counts = await queue.getJobCounts();
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(1);

    const finalJob = await queue.getJob(event.id);
    expect(finalJob?.id).toBe(event.id);
  });
});
