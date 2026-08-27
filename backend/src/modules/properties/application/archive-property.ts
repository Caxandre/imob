import type { Property } from "../domain/property.js";
import { PropertyNotFoundError } from "../domain/property.js";
import type { PropertyRepository } from "./property-repository.js";

/**
 * Archives a property (`status = INACTIVE`) in the already-resolved tenant's database — never
 * a physical delete. Idempotent: archiving an already-`INACTIVE` property still succeeds.
 * Throws {@link PropertyNotFoundError} when the property does not exist.
 */
export async function archiveProperty(repository: PropertyRepository, id: string): Promise<Property> {
  const property = await repository.archive(id);

  if (!property) {
    throw new PropertyNotFoundError(id);
  }

  return property;
}
