import type { Property } from "../domain/property.js";
import type { PropertyRepository } from "./property-repository.js";

export interface ListPropertiesInput {
  page: number;
  limit: number;
}

export interface ListPropertiesPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ListPropertiesOutput {
  data: Property[];
  pagination: ListPropertiesPagination;
}

/**
 * Lists properties in the already-resolved tenant's database, ordered deterministically
 * (`created_at DESC, id DESC` — see `PropertyRepository`/schema) and paginated. `totalPages`
 * is computed here, not by the repository, since it is pure arithmetic over `total`/`limit`
 * with no need for another round trip to the database.
 */
export async function listProperties(
  repository: PropertyRepository,
  input: ListPropertiesInput,
): Promise<ListPropertiesOutput> {
  const { data, total } = await repository.list(input);

  return {
    data,
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit),
    },
  };
}
