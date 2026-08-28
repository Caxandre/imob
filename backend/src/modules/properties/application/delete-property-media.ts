import type { ObjectStorage } from "../../../infrastructure/object-storage/object-storage.js";
import { PropertyNotFoundError } from "../domain/property.js";
import type { PropertyMediaRepository } from "./property-media-repository.js";
import type { PropertyRepository } from "./property-repository.js";

/**
 * Outcome of a delete — never thrown for a failed R2 cleanup (this task, section 36/60):
 * `objectStorageDeleted: false` tells the caller (the route handler) to log a warning about a
 * likely orphan object in R2, but the HTTP operation itself still reports success (204) because
 * the metadata removal — the part of "delete" that matters for correctness — already committed.
 */
export interface DeletePropertyMediaOutcome {
  objectKey: string;
  objectStorageDeleted: boolean;
}

/**
 * Removes one property media (Prompt 028). Consistency order is the *opposite* of upload
 * (ADR-007 "Delete"): the PostgreSQL metadata row is removed — and the gallery reindexed/cover
 * reassigned, all inside one transaction — *before* the real Cloudflare R2 object is touched at
 * all. Only once that transaction has committed does this function attempt
 * `ObjectStorage.deleteObject()`, and only as best-effort: a failure there is caught, never
 * rethrown, and never undoes the already-committed metadata removal — an orphaned R2 object is
 * preferable to persisted metadata that points at a missing/inaccessible one (ADR-007).
 *
 * If the PostgreSQL transaction itself fails (e.g. `PropertyMediaNotFoundError` — the media
 * does not exist or belongs to a different property/tenant), `ObjectStorage.deleteObject()` is
 * never called (this task, section 61/62) — the error propagates directly from
 * `propertyMediaRepository.delete()`, before this function's own try/catch around the R2 call
 * is ever reached.
 *
 * Allowed for an `INACTIVE` (archived) property (this task, section 30) — cleaning up an
 * existing gallery is maintenance, not new content, so archiving does not block it.
 */
export async function deletePropertyMedia(
  propertyRepository: PropertyRepository,
  propertyMediaRepository: PropertyMediaRepository,
  objectStorage: ObjectStorage,
  propertyId: string,
  mediaId: string,
): Promise<DeletePropertyMediaOutcome> {
  const property = await propertyRepository.findById(propertyId);
  if (!property) {
    throw new PropertyNotFoundError(propertyId);
  }

  const { objectKey } = await propertyMediaRepository.delete(propertyId, mediaId);

  let objectStorageDeleted = false;
  try {
    await objectStorage.deleteObject(objectKey);
    objectStorageDeleted = true;
  } catch {
    // Deliberately swallowed (ADR-007 "Delete", this task, section 36) — the metadata removal
    // already committed and must be reported as a success regardless; the caller decides how
    // to log `objectStorageDeleted: false` safely (bucket/key/mediaId only, never a secret).
  }

  return { objectKey, objectStorageDeleted };
}
