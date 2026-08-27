import type { Property } from "../domain/property.js";
import { PropertyNotFoundError } from "../domain/property.js";
import type { PropertyRepository, UpdatePropertyInput } from "./property-repository.js";

export type { UpdatePropertyInput } from "./property-repository.js";

/** Partially updates a property in the already-resolved tenant's database. Throws {@link PropertyNotFoundError} when absent. */
export async function updateProperty(
  repository: PropertyRepository,
  id: string,
  input: UpdatePropertyInput,
): Promise<Property> {
  const property = await repository.update(id, input);

  if (!property) {
    throw new PropertyNotFoundError(id);
  }

  return property;
}
