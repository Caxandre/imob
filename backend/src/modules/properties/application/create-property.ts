import type { Property } from "../domain/property.js";
import type { CreatePropertyInput, PropertyRepository } from "./property-repository.js";

export type { CreatePropertyInput } from "./property-repository.js";

/** Creates a property in the already-resolved tenant's database. No SQL here — see `PropertyRepository`. */
export async function createProperty(
  repository: PropertyRepository,
  input: CreatePropertyInput,
): Promise<Property> {
  return repository.create(input);
}
