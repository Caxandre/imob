import { asc, eq, sql } from "drizzle-orm";

import { properties, propertyMedia } from "../../../infrastructure/database/tenant/schema.js";
import type { TenantDatabase } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { PropertyMedia, PropertyMediaMimeType } from "../domain/property-media.js";
import type { CreatePropertyMediaInput, PropertyMediaRepository } from "../application/property-media-repository.js";

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Real, Drizzle-backed `PropertyMediaRepository`. Same convention as
 * `drizzle-property-repository.ts`: takes an already-scoped `TenantDatabase`, never a
 * `tenantId` or a way to pick which database to talk to.
 */
export function createDrizzlePropertyMediaRepository(db: TenantDatabase): PropertyMediaRepository {
  return {
    async create(input: CreatePropertyMediaInput): Promise<PropertyMedia> {
      const row = await db.transaction(async (tx) => {
        // Row-locks the parent property (this task, section 16) — every concurrent upload for
        // the same property serializes on this lock before computing the next position, so two
        // concurrent transactions can never compute the same MAX(position)+1. Locking the
        // property's own row (rather than a separate advisory lock hashed from its id) reuses a
        // lock PostgreSQL already gives us for free, with no extra bookkeeping. The row is
        // known to exist — the application layer (`uploadPropertyMedia`) already confirmed it
        // via `PropertyRepository.findById()` before this repository is ever called, and
        // properties are never physically deleted (CLAUDE.md) — so no "not found" handling is
        // needed here.
        await tx.select({ id: properties.id }).from(properties).where(eq(properties.id, input.propertyId)).for("update");

        const [positionRow] = await tx
          .select({ nextPosition: sql<number>`coalesce(max(${propertyMedia.position}), -1) + 1` })
          .from(propertyMedia)
          .where(eq(propertyMedia.propertyId, input.propertyId));
        const nextPosition = positionRow?.nextPosition ?? 0;

        const [inserted] = await tx
          .insert(propertyMedia)
          .values({ ...input, position: nextPosition })
          .returning();

        if (!inserted) {
          throw new Error("property_media insert returned no row");
        }

        return inserted;
      });

      return toPropertyMedia(row);
    },

    async listByProperty(propertyId: string): Promise<PropertyMedia[]> {
      const rows = await db
        .select()
        .from(propertyMedia)
        .where(eq(propertyMedia.propertyId, propertyId))
        // `id` tie-break is purely defensive (this task, section 46) — `UNIQUE(property_id,
        // position)` already makes an actual position tie impossible.
        .orderBy(asc(propertyMedia.position), asc(propertyMedia.id));

      return rows.map(toPropertyMedia);
    },
  };
}
