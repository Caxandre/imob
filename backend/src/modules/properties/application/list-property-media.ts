import type { PropertyMedia } from "../domain/property-media.js";
import { PropertyNotFoundError } from "../domain/property.js";
import type { PropertyMediaRepository } from "./property-media-repository.js";
import type { PropertyRepository } from "./property-repository.js";

/**
 * Lists media for a property, always validating the property exists first (this task, section
 * 47) — even though an unknown property naturally has zero media rows either way, a 404 is
 * still correct here: the addressed resource itself does not exist. `INACTIVE` properties are
 * readable (archiving never hides media — section 48/78): no status check here, unlike
 * `uploadPropertyMedia`.
 */
export async function listPropertyMedia(
  propertyRepository: PropertyRepository,
  propertyMediaRepository: PropertyMediaRepository,
  propertyId: string,
): Promise<PropertyMedia[]> {
  const property = await propertyRepository.findById(propertyId);
  if (!property) {
    throw new PropertyNotFoundError(propertyId);
  }

  return propertyMediaRepository.listByProperty(propertyId);
}
