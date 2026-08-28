import type { PropertyMedia, PropertyMediaMimeType } from "../domain/property-media.js";

/**
 * `id`/`objectKey`/`publicUrl` are generated/resolved by the caller (`upload-property-media.ts`)
 * *before* this repository is ever invoked — the upload to Cloudflare R2 has already happened by
 * the time `create()` runs (this task, section 34: validate → upload R2 → DB insert). `position`
 * is deliberately absent: assigning it safely under concurrent uploads for the same property is
 * this repository's own responsibility (section 16), never the caller's.
 */
export interface CreatePropertyMediaInput {
  id: string;
  propertyId: string;
  objectKey: string;
  publicUrl: string;
  mimeType: PropertyMediaMimeType;
  sizeBytes: number;
  originalFilename: string | null;
}

/**
 * Persistence port for property media metadata. Like `PropertyRepository`, always operates
 * against an already-scoped `db` handle for one tenant's database — never a `tenantId`
 * parameter, never resolves a tenant itself.
 */
export interface PropertyMediaRepository {
  /**
   * Assigns `position` safely under concurrent uploads for the same property (this task,
   * section 16) — the exact mechanism (row lock on the parent `properties` row, transaction)
   * is an infrastructure/adapter concern, not part of this contract.
   */
  create(input: CreatePropertyMediaInput): Promise<PropertyMedia>;
  /** Ordered `position ASC, id ASC` (this task, section 46) — deterministic even though
   * `UNIQUE(property_id, position)` makes an actual position tie impossible. */
  listByProperty(propertyId: string): Promise<PropertyMedia[]>;
}
