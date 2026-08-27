import type { Property } from "../domain/property.js";
import { PropertyNotFoundError } from "../domain/property.js";
import type { PropertyRepository } from "./property-repository.js";

/** Fetches a single property from the already-resolved tenant's database. Throws {@link PropertyNotFoundError} when absent. */
export async function getProperty(repository: PropertyRepository, id: string): Promise<Property> {
  const property = await repository.findById(id);

  if (!property) {
    throw new PropertyNotFoundError(id);
  }

  return property;
}
