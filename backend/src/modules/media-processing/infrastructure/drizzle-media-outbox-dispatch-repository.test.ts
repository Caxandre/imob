import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runTenantMigrations } from "../../../infrastructure/database/tenant/migrate.js";
import * as tenantSchema from "../../../infrastructure/database/tenant/schema.js";
import {
  PROPERTY_MEDIA_AGGREGATE_TYPE,
  PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE,
} from "../../properties/domain/property-media-processing-event.js";
import { createDrizzleMediaOutboxDispatchRepository } from "./drizzle-media-outbox-dispatch-repository.js";

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
  const databaseName = `media_outbox_dispatch_test_${randomUUID().replaceAll("-", "")}`;
  await withAdminClient((client) => client.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`));

  await runTenantMigrations({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  const pool = new Pool({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  createdFixtures.push({ databaseName, pool });

  return drizzle(pool, { schema: tenantSchema });
}

function samplePayload() {
  return { propertyId: randomUUID(), mediaId: randomUUID() };
}

async function insertOutboxEvent(
  db: Awaited<ReturnType<typeof createMigratedTenantDatabase>>,
  overrides: {
    aggregateType?: string;
    eventType?: string;
    payload?: unknown;
    occurredAtOffsetMs?: number;
  } = {},
) {
  const occurredAt =
    overrides.occurredAtOffsetMs === undefined ? new Date() : new Date(Date.now() + overrides.occurredAtOffsetMs);
  const [row] = await db
    .insert(tenantSchema.outboxEvents)
    .values({
      aggregateType: overrides.aggregateType ?? PROPERTY_MEDIA_AGGREGATE_TYPE,
      aggregateId: randomUUID(),
      eventType: overrides.eventType ?? PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE,
      payload: overrides.payload ?? samplePayload(),
      occurredAt,
    })
    .returning();
  if (!row) {
    throw new Error("outbox_events insert returned no row");
  }
  return row;
}

describe("createDrizzleMediaOutboxDispatchRepository", () => {
  describe("claimEligibleEvents", () => {
    it("claims a pending PROPERTY_MEDIA_PROCESSING_REQUESTED event and sets claim/lease", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      const event = await insertOutboxEvent(db);

      const claimed = await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });

      expect(claimed).toEqual([{ id: event.id, payload: event.payload }]);

      const [row] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, event.id));
      expect(row?.dispatchClaimedAt).toBeInstanceOf(Date);
      expect(row?.dispatchLeaseUntil).toBeInstanceOf(Date);
      expect(row?.dispatchedAt).toBeNull();
    });

    it("ignores an event of a different aggregate_type/event_type — the outbox stays a generic table", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      await insertOutboxEvent(db, { aggregateType: "SOME_OTHER_AGGREGATE", eventType: "SOME_OTHER_EVENT" });
      await insertOutboxEvent(db, { eventType: "SOME_OTHER_EVENT" });

      await expect(repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 })).resolves.toEqual([]);
    });

    it("ignores an already-dispatched event", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      const event = await insertOutboxEvent(db);
      await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });
      await repository.markDispatched(event.id);

      await expect(repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 })).resolves.toEqual([]);
    });

    it("ignores an event already marked processed", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      const event = await insertOutboxEvent(db);
      await db.update(tenantSchema.outboxEvents).set({ processedAt: sql`now()` }).where(eq(tenantSchema.outboxEvents.id, event.id));

      await expect(repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 })).resolves.toEqual([]);
    });

    it("ignores an event already marked dispatch-failed", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      const event = await insertOutboxEvent(db);
      await repository.markDispatchFailed(event.id, "Invalid payload");

      await expect(repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 })).resolves.toEqual([]);
    });

    it("returns claims in FIFO order (created_at ASC, id ASC)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      // created_at is defaultNow() at insert time — each call here runs strictly after the
      // previous one has committed, so created_at is monotonically non-decreasing across them.
      const first = await insertOutboxEvent(db);
      const second = await insertOutboxEvent(db);
      const third = await insertOutboxEvent(db);

      const claimed = await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });

      expect(claimed.map((e) => e.id)).toEqual([first.id, second.id, third.id]);
    });

    it("respects batchSize", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      await insertOutboxEvent(db);
      await insertOutboxEvent(db);
      await insertOutboxEvent(db);

      const claimed = await repository.claimEligibleEvents({ batchSize: 2, leaseSeconds: 30 });

      expect(claimed).toHaveLength(2);
    });

    it("does not reclaim an event whose lease has not expired yet", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      await insertOutboxEvent(db);

      const first = await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });
      const second = await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    it("reclaims an event whose lease has expired", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      const event = await insertOutboxEvent(db);

      await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });
      // Simulate lease expiry deterministically instead of a real sleep.
      await db
        .update(tenantSchema.outboxEvents)
        .set({ dispatchLeaseUntil: sql`now() - interval '1 second'` })
        .where(eq(tenantSchema.outboxEvents.id, event.id));

      const reclaimed = await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });

      expect(reclaimed).toEqual([{ id: event.id, payload: event.payload }]);
    });

    it("prevents two concurrent claims on the same tenant DB from claiming the same event (FOR UPDATE SKIP LOCKED)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      await insertOutboxEvent(db);
      await insertOutboxEvent(db);

      const [batchA, batchB] = await Promise.all([
        repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 }),
        repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 }),
      ]);

      const claimedIds = [...batchA, ...batchB].map((e) => e.id);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect(claimedIds).toHaveLength(2);
    });
  });

  describe("markDispatched", () => {
    it("sets dispatched_at and clears the lease", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      const event = await insertOutboxEvent(db);
      await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });

      await repository.markDispatched(event.id);

      const [row] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, event.id));
      expect(row?.dispatchedAt).toBeInstanceOf(Date);
      expect(row?.dispatchLeaseUntil).toBeNull();
    });

    it("is a no-op when the event was already dispatched — never overwrites the first timestamp", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      const event = await insertOutboxEvent(db);
      await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });
      await repository.markDispatched(event.id);
      const [before] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, event.id));

      await repository.markDispatched(event.id);

      const [after] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, event.id));
      expect(after?.dispatchedAt?.toISOString()).toBe(before?.dispatchedAt?.toISOString());
    });
  });

  describe("releaseLease", () => {
    it("clears the lease but keeps dispatch_claimed_at for observability", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      const event = await insertOutboxEvent(db);
      await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });

      await repository.releaseLease(event.id);

      const [row] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, event.id));
      expect(row?.dispatchLeaseUntil).toBeNull();
      expect(row?.dispatchClaimedAt).toBeInstanceOf(Date);

      // Immediately re-claimable after releasing.
      const reclaimed = await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });
      expect(reclaimed.map((e) => e.id)).toEqual([event.id]);
    });
  });

  describe("markDispatchFailed", () => {
    it("sets dispatch_failed_at and dispatch_error, clears the lease, and excludes the event from further claims", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzleMediaOutboxDispatchRepository(db);
      const event = await insertOutboxEvent(db);
      await repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 });

      await repository.markDispatchFailed(event.id, "Invalid PROPERTY_MEDIA_PROCESSING_REQUESTED payload");

      const [row] = await db.select().from(tenantSchema.outboxEvents).where(eq(tenantSchema.outboxEvents.id, event.id));
      expect(row?.dispatchFailedAt).toBeInstanceOf(Date);
      expect(row?.dispatchError).toBe("Invalid PROPERTY_MEDIA_PROCESSING_REQUESTED payload");
      expect(row?.dispatchLeaseUntil).toBeNull();

      await expect(repository.claimEligibleEvents({ batchSize: 10, leaseSeconds: 30 })).resolves.toEqual([]);
    });
  });
});
