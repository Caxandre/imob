import type { PropertyMedia } from "../domain/property-media.js";
import { PropertyNotFoundError } from "../domain/property.js";
import type { PropertyMediaRepository } from "./property-media-repository.js";
import type { PropertyRepository } from "./property-repository.js";

/**
 * Selects one media as a property's cover, unsetting any previous one (Prompt 028). Allowed for
 * an `INACTIVE` (archived) property (this task, section 30) — same reasoning as
 * `reorderPropertyMedia`: gallery maintenance on existing media, not new content, so archiving
 * does not block it.
 */
export async function setPropertyMediaCover(
  propertyRepository: PropertyRepository,
  propertyMediaRepository: PropertyMediaRepository,
  propertyId: string,
  mediaId: string,
): Promise<PropertyMedia> {
  const property = await propertyRepository.findById(propertyId);
  if (!property) {
    throw new PropertyNotFoundError(propertyId);
  }

  return propertyMediaRepository.setCover(propertyId, mediaId);
}
