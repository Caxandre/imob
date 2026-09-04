import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { outboxEvents, properties, propertyMedia, propertyMediaVariants } from "../../../infrastructure/database/tenant/schema.js";
import type { TenantDatabase } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import {
  PROPERTY_MEDIA_AGGREGATE_TYPE,
  PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE,
  type PropertyMediaProcessingRequestedPayload,
} from "../domain/property-media-processing-event.js";
import {
  PropertyMediaNotFoundError,
  PropertyMediaReorderMismatchError,
  type PropertyMedia,
  type PropertyMediaMimeType,
  type PropertyMediaWithVariants,
} from "../domain/property-media.js";
import {
  emptyPropertyMediaVariantSet,
  toPropertyMediaVariantSet,
  type PropertyMediaVariant,
  type PropertyMediaVariantSet,
} from "../domain/property-media-variant.js";
import type {
  CreatePropertyMediaInput,
  DeletePropertyMediaResult,
  PropertyMediaRepository,
} from "../application/property-media-repository.js";

function toPropertyMedia(row: typeof propertyMedia.$inferSelect): PropertyMedia {
  return {
    id: row.id,
    propertyId: row.propertyId,
    objectKey: row.objectKey,
    publicUrl: row.publicUrl,
    // `mime_type` is a plain `text` column at the Drizzle level (no native enum type was worth
    // introducing for 3 values) but is guaranteed to be one of `PropertyMediaMimeType` by the
    // table's own `property_media_mime_type_allowed` CHECK constraint — the cast reflects a
    // real DB-enforced invariant, not an assumption.
    mimeType: row.mimeType as PropertyMediaMimeType,
    sizeBytes: row.sizeBytes,
    originalFilename: row.originalFilename,
    position: row.position,
    isCover: row.isCover,
    processingStatus: row.processingStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPropertyMediaVariant(row: typeof propertyMediaVariants.$inferSelect): PropertyMediaVariant {
  return {
    id: row.id,
    propertyMediaId: row.propertyMediaId,
    variant: row.variant,
    objectKey: row.objectKey,
    publicUrl: row.publicUrl,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Loads every variant row for a batch of media ids in one query — never one query per media
 * (Prompt 035, sections 13-15): a single `SELECT ... WHERE property_media_id IN (...)`, grouped
 * in memory afterward. `mediaIds.length === 0` short-circuits without a round trip (an empty
 * property, or a call sized for the empty gallery). The returned `Map` has an entry for every
 * requested id — including ones with zero variant rows, mapped to `emptyPropertyMediaVariantSet()`
 * — so callers never need an extra `?? emptyPropertyMediaVariantSet()` at each use site.
 */
async function loadVariantSetsByMediaIds(
  db: TenantDatabase,
  mediaIds: readonly string[],
): Promise<Map<string, PropertyMediaVariantSet>> {
  const sets = new Map<string, PropertyMediaVariantSet>();
  for (const id of mediaIds) sets.set(id, emptyPropertyMediaVariantSet());

  if (mediaIds.length === 0) return sets;

  const rows = await db
    .select()
    .from(propertyMediaVariants)
    .where(inArray(propertyMediaVariants.propertyMediaId, mediaIds as string[]));

  const byMediaId = new Map<string, PropertyMediaVariant[]>();
  for (const row of rows) {
    const variant = toPropertyMediaVariant(row);
    const bucket = byMediaId.get(variant.propertyMediaId);
    if (bucket) bucket.push(variant);
    else byMediaId.set(variant.propertyMediaId, [variant]);
  }

  for (const [mediaId, variants] of byMediaId) {
    sets.set(mediaId, toPropertyMediaVariantSet(variants));
  }

  return sets;
}

/** Row-locks the parent property — every mutating method below starts with this, inside its own
 * transaction, so concurrent calls for the same property always serialize (Prompt 028, sections
 * 14/16/21/27/43). The row is assumed to exist: the application layer
 * (`upload-property-media.ts`/`reorder-property-media.ts`/etc.) already confirmed it via
 * `PropertyRepository.findById()` before any repository here is called, and properties are
 * never physically deleted (CLAUDE.md) — so no "not found" handling is needed on this lock. */
async function lockProperty(tx: TenantDatabase, propertyId: string): Promise<void> {
  await tx.select({ id: properties.id }).from(properties).where(eq(properties.id, propertyId)).for("update");
}

/**
 * Real, Drizzle-backed `PropertyMediaRepository`. Same convention as
 * `drizzle-property-repository.ts`: takes an already-scoped `TenantDatabase`, never a
 * `tenantId` or a way to pick which database to talk to.
 */
export function createDrizzlePropertyMediaRepository(db: TenantDatabase): PropertyMediaRepository {
  return {
    async create(input: CreatePropertyMediaInput): Promise<PropertyMediaWithVariants> {
      const row = await db.transaction(async (tx) => {
        // Row-locks the parent property (this task, section 16) — every concurrent upload for
        // the same property serializes on this lock before computing the next position, so two
        // concurrent transactions can never compute the same MAX(position)+1. Locking the
        // property's own row (rather than a separate advisory lock hashed from its id) reuses a
        // lock PostgreSQL already gives us for free, with no extra bookkeeping.
        await lockProperty(tx, input.propertyId);

        const [positionRow] = await tx
          .select({ nextPosition: sql<number>`coalesce(max(${propertyMedia.position}), -1) + 1` })
          .from(propertyMedia)
          .where(eq(propertyMedia.propertyId, input.propertyId));
        const nextPosition = positionRow?.nextPosition ?? 0;
        // Same locked read decides the cover (Prompt 028, sections 7/13/14): the first media
        // for a property (nextPosition === 0, i.e. no existing rows) becomes its cover; every
        // later upload does not. Computed from the exact same count as `position` — no second,
        // separate query that could race against a concurrent upload.
        const isCover = nextPosition === 0;

        const [inserted] = await tx
          .insert(propertyMedia)
          // `processingStatus` is always explicit here, never left to the column's own default
          // (Prompt 030, ADR-008, section 5) — the DB default (`READY`) exists purely to
          // backfill rows from before this column existed (section 6), never as the value a new
          // upload should silently fall back to.
          .values({ ...input, position: nextPosition, isCover, processingStatus: "PROCESSING" })
          .returning();

        if (!inserted) {
          throw new Error("property_media insert returned no row");
        }

        // Same transaction as the insert above (this task, section 45/48): the durable intent
        // to process this media's variants is recorded atomically with the media row itself —
        // if either write fails, both roll back together, and no separate BullMQ call ever runs
        // inside (or depends on) this transaction. Reuses the Tenant Data Plane's existing
        // `outbox_events` table (section 49) rather than a new media-specific jobs table.
        // `occurredAt` uses the database's own `now()` (matching `updatedAt` elsewhere in this
        // file), never `new Date()` from the application.
        const payload: PropertyMediaProcessingRequestedPayload = {
          propertyId: input.propertyId,
          mediaId: inserted.id,
        };
        await tx.insert(outboxEvents).values({
          aggregateType: PROPERTY_MEDIA_AGGREGATE_TYPE,
          aggregateId: inserted.id,
          eventType: PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE,
          payload,
          occurredAt: sql`now()`,
        });

        return inserted;
      });

      // A media row that was just inserted in this same call can only have zero variant rows —
      // the worker cannot possibly have run yet — so this is a plain empty set, never a query
      // (this task, section 18/46).
      return { ...toPropertyMedia(row), variants: emptyPropertyMediaVariantSet() };
    },

    async listByProperty(propertyId: string): Promise<PropertyMediaWithVariants[]> {
      const rows = await db
        .select()
        .from(propertyMedia)
        .where(eq(propertyMedia.propertyId, propertyId))
        // `id` tie-break is purely defensive (this task, section 46) — `UNIQUE(property_id,
        // position)` already makes an actual position tie impossible.
        .orderBy(asc(propertyMedia.position), asc(propertyMedia.id));

      // One extra query for every media's variants combined, never one per media (this task,
      // sections 14/15/45) — O(1) relative to the gallery size (two queries total, always).
      const variantSets = await loadVariantSetsByMediaIds(db, rows.map((row) => row.id));

      return rows.map((row) => ({
        ...toPropertyMedia(row),
        variants: variantSets.get(row.id) ?? emptyPropertyMediaVariantSet(),
      }));
    },

    async reorder(propertyId: string, mediaIds: string[]): Promise<PropertyMediaWithVariants[]> {
      const rows = await db.transaction(async (tx) => {
        await lockProperty(tx, propertyId);

        const currentRows = await tx
          .select({ id: propertyMedia.id })
          .from(propertyMedia)
          .where(eq(propertyMedia.propertyId, propertyId));
        const currentIds = new Set(currentRows.map((row) => row.id));

        // Every submitted id must genuinely belong to this property — checked before the count
        // comparison below, so an unknown/foreign id always reports 404, never 409 (this task,
        // section 18; duplicates within `mediaIds` are already rejected at the HTTP boundary,
        // Zod, before this repository is ever called — section 19).
        for (const id of mediaIds) {
          if (!currentIds.has(id)) {
            throw new PropertyMediaNotFoundError(id);
          }
        }
        // Every id provided is confirmed valid at this point — a length mismatch can only mean
        // the submission is missing some of the property's current media (section 17/20).
        if (mediaIds.length !== currentIds.size) {
          throw new PropertyMediaReorderMismatchError(propertyId);
        }

        if (mediaIds.length > 0) {
          // Two-phase offset (this task, section 22): shifting every row for this property by
          // +N first guarantees no intermediate UNIQUE(property_id, position) collision — old
          // positions are a permutation of 0..N-1, so old+N never collides with a not-yet-
          // shifted row's old value (always < N) or with another already-shifted row (shift is
          // injective). Phase two then assigns each id its final 0..N-1 target one at a time;
          // targets are unique by construction (mediaIds has no duplicates) and never collide
          // with any row still sitting in the N..2N-1 range from phase one.
          const n = mediaIds.length;
          await tx
            .update(propertyMedia)
            .set({ position: sql`${propertyMedia.position} + ${n}`, updatedAt: sql`now()` })
            .where(eq(propertyMedia.propertyId, propertyId));

          for (let index = 0; index < mediaIds.length; index += 1) {
            await tx
              .update(propertyMedia)
              .set({ position: index, updatedAt: sql`now()` })
              .where(eq(propertyMedia.id, mediaIds[index]!));
          }
        }

        // `isCover` is never touched here (this task, section 23) — reorder only.
        return tx
          .select()
          .from(propertyMedia)
          .where(eq(propertyMedia.propertyId, propertyId))
          .orderBy(asc(propertyMedia.position), asc(propertyMedia.id));
      });

      // Outside the transaction, same reasoning as `listByProperty` — reordering never creates
      // or destroys variant rows, so this read needs no lock (this task, section 15/17).
      const variantSets = await loadVariantSetsByMediaIds(db, rows.map((row) => row.id));

      return rows.map((row) => ({
        ...toPropertyMedia(row),
        variants: variantSets.get(row.id) ?? emptyPropertyMediaVariantSet(),
      }));
    },

    async setCover(propertyId: string, mediaId: string): Promise<PropertyMediaWithVariants> {
      const row = await db.transaction(async (tx) => {
        await lockProperty(tx, propertyId);

        const [media] = await tx
          .select({ id: propertyMedia.id })
          .from(propertyMedia)
          .where(and(eq(propertyMedia.id, mediaId), eq(propertyMedia.propertyId, propertyId)));
        if (!media) {
          throw new PropertyMediaNotFoundError(mediaId);
        }

        // Idempotent by convergence (this task, section 26), same pattern already used by
        // `archive()` in `drizzle-property-repository.ts`: unset whatever is currently the
        // cover (including `mediaId` itself, if it already is), then set `mediaId` — never a
        // read-before-write short circuit for "already the cover".
        await tx
          .update(propertyMedia)
          .set({ isCover: false, updatedAt: sql`now()` })
          .where(and(eq(propertyMedia.propertyId, propertyId), eq(propertyMedia.isCover, true)));

        const [updated] = await tx
          .update(propertyMedia)
          .set({ isCover: true, updatedAt: sql`now()` })
          .where(eq(propertyMedia.id, mediaId))
          .returning();

        if (!updated) {
          throw new Error("property_media update returned no row");
        }
        return updated;
      });

      // setCover never creates/destroys variant rows either — a single-media lookup, same
      // batch helper reused with an array of one (this task, section 26).
      const variantSets = await loadVariantSetsByMediaIds(db, [row.id]);

      return { ...toPropertyMedia(row), variants: variantSets.get(row.id) ?? emptyPropertyMediaVariantSet() };
    },

    async delete(propertyId: string, mediaId: string): Promise<DeletePropertyMediaResult> {
      return db.transaction(async (tx) => {
        await lockProperty(tx, propertyId);

        const [media] = await tx
          .select()
          .from(propertyMedia)
          .where(and(eq(propertyMedia.id, mediaId), eq(propertyMedia.propertyId, propertyId)));
        if (!media) {
          throw new PropertyMediaNotFoundError(mediaId);
        }

        // Read before the delete (Prompt 032, section 64) — `ON DELETE CASCADE` (Prompt 030)
        // removes these rows the instant `propertyMedia` is deleted below, so their object keys
        // must be captured now or they're gone. Zero rows is a normal outcome (media never
        // processed, or still PROCESSING/FAILED), never assumed to be exactly three.
        const variants = await tx
          .select({ objectKey: propertyMediaVariants.objectKey })
          .from(propertyMediaVariants)
          .where(eq(propertyMediaVariants.propertyMediaId, mediaId));

        await tx.delete(propertyMedia).where(eq(propertyMedia.id, mediaId));

        // Old positions (pre-reindex) still correctly reflect relative order — deleting one row
        // only leaves a gap, it never reorders the others.
        const remaining = await tx
          .select({ id: propertyMedia.id })
          .from(propertyMedia)
          .where(eq(propertyMedia.propertyId, propertyId))
          .orderBy(asc(propertyMedia.position), asc(propertyMedia.id));

        if (remaining.length > 0) {
          // Same two-phase offset strategy as `reorder()` — see its comment for why this never
          // collides with UNIQUE(property_id, position) (this task, section 42/43). The offset
          // must be `remaining.length + 1` here, not `remaining.length`: unlike `reorder()`
          // (where nothing is removed, so old positions are already the contiguous set
          // `0..N-1`), the just-deleted row leaves a *gap* — remaining old positions are a
          // subset of `0..remaining.length` (inclusive), so the offset needs to clear that
          // wider range to guarantee no collision.
          const n = remaining.length + 1;
          await tx
            .update(propertyMedia)
            .set({ position: sql`${propertyMedia.position} + ${n}`, updatedAt: sql`now()` })
            .where(eq(propertyMedia.propertyId, propertyId));

          for (let index = 0; index < remaining.length; index += 1) {
            await tx
              .update(propertyMedia)
              .set({ position: index, updatedAt: sql`now()` })
              .where(eq(propertyMedia.id, remaining[index]!.id));
          }

          // The deleted media was the cover and others remain: the new position-0 media
          // becomes the new cover (this task, section 39). Not the cover → untouched (section
          // 41). None remain → nothing to do, gallery has no cover (section 40).
          if (media.isCover) {
            await tx
              .update(propertyMedia)
              .set({ isCover: true, updatedAt: sql`now()` })
              .where(eq(propertyMedia.id, remaining[0]!.id));
          }
        }

        // Real Cloudflare R2 deletion is the caller's job, strictly after this transaction
        // commits (ADR-007 "Delete") — this repository never touches ObjectStorage itself.
        return { objectKey: media.objectKey, variantObjectKeys: variants.map((v) => v.objectKey) };
      });
    },
  };
}
