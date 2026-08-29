import { and, eq, isNull, sql } from "drizzle-orm";

import { outboxEvents, propertyMedia, propertyMediaVariants } from "../../../infrastructure/database/tenant/schema.js";
import {
  PROPERTY_MEDIA_AGGREGATE_TYPE,
  PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE,
} from "../../properties/domain/property-media-processing-event.js";
import type { TenantDatabase } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type {
  FinalizePropertyMediaResult,
  LoadPropertyMediaProcessingContextResult,
  PropertyMediaProcessingRepository,
  UploadedPropertyMediaVariant,
} from "../application/property-media-processing-repository.js";

/** Marks the outbox event processed, guarded by `processedAt IS NULL` so a delayed/duplicate
 * confirmation never overwrites an already-recorded completion (same convention as
 * `drizzle-media-outbox-dispatch-repository.ts`'s `markDispatched`). */
async function markProcessed(db: TenantDatabase, outboxEventId: string): Promise<void> {
  await db
    .update(outboxEvents)
    .set({ processedAt: sql`now()` })
    .where(and(eq(outboxEvents.id, outboxEventId), isNull(outboxEvents.processedAt)));
}

export function createDrizzlePropertyMediaProcessingRepository(
  db: TenantDatabase,
): PropertyMediaProcessingRepository {
  return {
    async loadContext(input): Promise<LoadPropertyMediaProcessingContextResult> {
      const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, input.outboxEventId));

      if (
        !event ||
        event.aggregateType !== PROPERTY_MEDIA_AGGREGATE_TYPE ||
        event.eventType !== PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE ||
        event.aggregateId !== input.mediaId
      ) {
        // Defensive — unreachable through the normal upload→outbox→dispatcher path, where this
        // codebase is the only writer and always keeps these fields consistent (this task,
        // section 39). Never processed as if it were a real request.
        return { outcome: "invalid-event" };
      }

      if (event.processedAt !== null) {
        return { outcome: "already-processed" };
      }

      const [media] = await db.select().from(propertyMedia).where(eq(propertyMedia.id, input.mediaId));
      if (!media) {
        return { outcome: "media-missing" };
      }
      if (media.propertyId !== input.propertyId) {
        // The job payload's propertyId doesn't match the media's real property — a permanent,
        // safe-to-fail mismatch (section 44), never processed.
        return { outcome: "invalid-event" };
      }

      return {
        outcome: "ready",
        context: { mediaId: media.id, propertyId: media.propertyId, objectKey: media.objectKey, mimeType: media.mimeType },
      };
    },

    async markObsoleteProcessed(outboxEventId: string): Promise<void> {
      await markProcessed(db, outboxEventId);
    },

    async finalizeReady(input: {
      outboxEventId: string;
      mediaId: string;
      variants: UploadedPropertyMediaVariant[];
    }): Promise<FinalizePropertyMediaResult> {
      return db.transaction(async (tx) => {
        // Row-locks property_media directly (not the parent property) — this finalize step
        // never touches position/cover/gallery ordering, so the broader property-row lock the
        // gallery mutations use isn't needed here; locking by media id alone is sufficient to
        // serialize against a concurrent delete (section 62) and correctly see it if one
        // commits first, via ordinary MVCC visibility on `FOR UPDATE`.
        const [media] = await tx.select({ id: propertyMedia.id }).from(propertyMedia).where(eq(propertyMedia.id, input.mediaId)).for("update");
        if (!media) {
          await tx.update(outboxEvents).set({ processedAt: sql`now()` }).where(and(eq(outboxEvents.id, input.outboxEventId), isNull(outboxEvents.processedAt)));
          return "media-missing";
        }

        for (const variant of input.variants) {
          await tx
            .insert(propertyMediaVariants)
            .values({
              propertyMediaId: input.mediaId,
              variant: variant.variant,
              objectKey: variant.objectKey,
              publicUrl: variant.publicUrl,
              mimeType: variant.mimeType,
              width: variant.width,
              height: variant.height,
              sizeBytes: variant.sizeBytes,
            })
            // Upsert on the same constraint idempotency depends on (section 50/51) — a retry
            // that re-processes the same media converges to one row per variant, never a
            // duplicate-key failure and never a second row.
            .onConflictDoUpdate({
              target: [propertyMediaVariants.propertyMediaId, propertyMediaVariants.variant],
              set: {
                objectKey: variant.objectKey,
                publicUrl: variant.publicUrl,
                mimeType: variant.mimeType,
                width: variant.width,
                height: variant.height,
                sizeBytes: variant.sizeBytes,
                updatedAt: sql`now()`,
              },
            });
        }

        await tx.update(propertyMedia).set({ processingStatus: "READY", updatedAt: sql`now()` }).where(eq(propertyMedia.id, input.mediaId));
        await tx.update(outboxEvents).set({ processedAt: sql`now()` }).where(and(eq(outboxEvents.id, input.outboxEventId), isNull(outboxEvents.processedAt)));

        return "finalized";
      });
    },

    async finalizeFailed(input: { outboxEventId: string; mediaId: string }): Promise<FinalizePropertyMediaResult> {
      return db.transaction(async (tx) => {
        const [media] = await tx.select({ id: propertyMedia.id }).from(propertyMedia).where(eq(propertyMedia.id, input.mediaId)).for("update");
        if (!media) {
          await tx.update(outboxEvents).set({ processedAt: sql`now()` }).where(and(eq(outboxEvents.id, input.outboxEventId), isNull(outboxEvents.processedAt)));
          return "media-missing";
        }

        await tx.update(propertyMedia).set({ processingStatus: "FAILED", updatedAt: sql`now()` }).where(eq(propertyMedia.id, input.mediaId));
        await tx.update(outboxEvents).set({ processedAt: sql`now()` }).where(and(eq(outboxEvents.id, input.outboxEventId), isNull(outboxEvents.processedAt)));

        return "finalized";
      });
    },
  };
}
