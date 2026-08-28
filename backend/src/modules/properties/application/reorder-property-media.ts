import type { PropertyMedia } from "../domain/property-media.js";
import { PropertyNotFoundError } from "../domain/property.js";
import type { PropertyMediaRepository } from "./property-media-repository.js";
import type { PropertyRepository } from "./property-repository.js";

/**
 * Replaces a property's entire gallery order (Prompt 028). `mediaIds` is expected already
 * validated/normalized by the HTTP boundary (UUID shape, no duplicates — this task, section
 * 67); this use case never parses/validates the array's shape itself. Whether the submitted
 * set exactly matches the property's current gallery — and the safe, lock-protected reindex
 * itself — is `PropertyMediaRepository.reorder()`'s job (see its own docs for the
 * `PropertyMediaNotFoundError`/`PropertyMediaReorderMismatchError` it can raise).
 *
 * Allowed for an `INACTIVE` (archived) property (this task, section 30) — unlike upload,
 * reordering an existing gallery is maintenance/cleanup, not adding new content, so archiving
 * does not block it. No status check here, deliberately.
 */
export async function reorderPropertyMedia(
  propertyRepository: PropertyRepository,
  propertyMediaRepository: PropertyMediaRepository,
  propertyId: string,
  mediaIds: string[],
): Promise<PropertyMedia[]> {
  const property = await propertyRepository.findById(propertyId);
  if (!property) {
    throw new PropertyNotFoundError(propertyId);
  }

  return propertyMediaRepository.reorder(propertyId, mediaIds);
}
