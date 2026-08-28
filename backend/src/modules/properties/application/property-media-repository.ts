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

/** Returned by `delete()` — just enough for the caller to remove the R2 object afterward
 * (Prompt 028, section 46). Never anything the caller would expose to an HTTP client. */
export interface DeletePropertyMediaResult {
  objectKey: string;
}

/**
 * Persistence port for property media metadata. Like `PropertyRepository`, always operates
 * against an already-scoped `db` handle for one tenant's database — never a `tenantId`
 * parameter, never resolves a tenant itself.
 */
export interface PropertyMediaRepository {
  /**
   * Assigns `position` *and* `isCover` safely under concurrent uploads for the same property
   * (this task, sections 7/13/14/16) — both are decided from the same locked read (row lock on
   * the parent `properties` row, transaction): the first media for a property becomes its
   * cover, every later one does not. The exact mechanism is an infrastructure/adapter concern,
   * not part of this contract; `CreatePropertyMediaInput` deliberately has no `isCover` field —
   * callers never decide it.
   */
  create(input: CreatePropertyMediaInput): Promise<PropertyMedia>;
  /** Ordered `position ASC, id ASC` (this task, section 46) — deterministic even though
   * `UNIQUE(property_id, position)` makes an actual position tie impossible. */
  listByProperty(propertyId: string): Promise<PropertyMedia[]>;
  /**
   * Replaces the property's entire gallery order (Prompt 028, sections 15-22). `mediaIds` must
   * be exactly the property's current media ids, as a permutation — no more, no fewer.
   * Rejects with {@link PropertyMediaNotFoundError} (from `../domain/property-media.js`) if any
   * id does not belong to this property, or {@link PropertyMediaReorderMismatchError} if the
   * set doesn't exactly match the current gallery. Never touches `isCover` (section 23). Returns
   * the gallery in its new order.
   */
  reorder(propertyId: string, mediaIds: string[]): Promise<PropertyMedia[]>;
  /**
   * Sets exactly one media as the property's cover, unsetting any previous one in the same
   * transaction (Prompt 028, sections 25-27). Idempotent — selecting the current cover again
   * still succeeds. Rejects with {@link PropertyMediaNotFoundError} if `mediaId` does not
   * belong to this property. Returns the now-cover media.
   */
  setCover(propertyId: string, mediaId: string): Promise<PropertyMedia>;
  /**
   * Removes one media's metadata row and reindexes the remaining gallery back to a gapless
   * `0..N-1` (Prompt 028, sections 31/35/42) — all inside one transaction, under the same
   * property row lock. If the removed media was the cover and others remain, the one now at
   * position 0 becomes the new cover (section 39); if none remain, the gallery has no cover
   * (section 40); if the removed media was not the cover, the current cover is untouched
   * (section 41). Never touches Cloudflare R2 itself — returns the removed row's `objectKey`
   * so the caller can delete the real object *after* this transaction has committed (ADR-007
   * "Delete"). Rejects with {@link PropertyMediaNotFoundError} if `mediaId` does not belong to
   * this property — R2 is never touched in that case either.
   */
  delete(propertyId: string, mediaId: string): Promise<DeletePropertyMediaResult>;
}
