import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { outboxEvents } from "../../../infrastructure/database/tenant/schema.js";
import {
  PROPERTY_MEDIA_AGGREGATE_TYPE,
  PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE,
} from "../../properties/domain/property-media-processing-event.js";
import type { TenantDatabase } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type {
  ClaimedMediaOutboxEvent,
  ClaimEligibleMediaOutboxEventsInput,
  MediaOutboxDispatchRepository,
} from "../application/dispatch-media-outbox-events.js";

/**
 * Real, Drizzle-backed `MediaOutboxDispatchRepository` — takes an already-scoped `TenantDatabase`
 * (Prompt 031), same convention as `drizzle-property-media-repository.ts`. Only ever reads/writes
 * the generic `outbox_events` table filtered down to the one event type this dispatcher owns
 * (`aggregate_type`/`event_type`, this task, section 13) — the table itself stays reusable for
 * any future outbox consumer (CLAUDE.md: no media-specific outbox table).
 */
export function createDrizzleMediaOutboxDispatchRepository(db: TenantDatabase): MediaOutboxDispatchRepository {
  return {
    async claimEligibleEvents({
      batchSize,
      leaseSeconds,
    }: ClaimEligibleMediaOutboxEventsInput): Promise<ClaimedMediaOutboxEvent[]> {
      return db.transaction(async (tx) => {
        // FOR UPDATE SKIP LOCKED lets concurrent dispatcher instances (or two tenants' chunks
        // within the same cycle) each claim a disjoint batch instead of colliding on the same
        // rows (this task, section 14, mirrors ADR-002 Step 1).
        const eligible = await tx
          .select({ id: outboxEvents.id, payload: outboxEvents.payload })
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.aggregateType, PROPERTY_MEDIA_AGGREGATE_TYPE),
              eq(outboxEvents.eventType, PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE),
              isNull(outboxEvents.processedAt),
              isNull(outboxEvents.dispatchedAt),
              isNull(outboxEvents.dispatchFailedAt),
              or(isNull(outboxEvents.dispatchLeaseUntil), sql`${outboxEvents.dispatchLeaseUntil} <= now()`),
            ),
          )
          .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
          .limit(batchSize)
          .for("update", { skipLocked: true });

        if (eligible.length === 0) {
          return [];
        }

        // now() (PostgreSQL) rather than the process clock — the lease is a database-level
        // concurrency mechanism, so its comparisons must use the database's own time (same
        // reasoning as the provisioning dispatcher, ADR-002).
        await tx
          .update(outboxEvents)
          .set({
            dispatchClaimedAt: sql`now()`,
            dispatchLeaseUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
          })
          .where(
            inArray(
              outboxEvents.id,
              eligible.map((row) => row.id),
            ),
          );

        return eligible.map((row) => ({ id: row.id, payload: row.payload }));
      });
    },

    async markDispatched(outboxEventId: string): Promise<void> {
      // Guarded by dispatchedAt IS NULL so a delayed/duplicate confirmation never overwrites
      // an already-confirmed dispatch (mirrors ADR-002 Step 4).
      await db
        .update(outboxEvents)
        .set({ dispatchedAt: sql`now()`, dispatchLeaseUntil: null })
        .where(and(eq(outboxEvents.id, outboxEventId), isNull(outboxEvents.dispatchedAt)));
    },

    async releaseLease(outboxEventId: string): Promise<void> {
      // dispatchClaimedAt is deliberately left untouched — same reasoning as ADR-002 Step 5.
      await db.update(outboxEvents).set({ dispatchLeaseUntil: null }).where(eq(outboxEvents.id, outboxEventId));
    },

    async markDispatchFailed(outboxEventId: string, reason: string): Promise<void> {
      await db
        .update(outboxEvents)
        .set({ dispatchFailedAt: sql`now()`, dispatchError: reason, dispatchLeaseUntil: null })
        .where(eq(outboxEvents.id, outboxEventId));
    },
  };
}
