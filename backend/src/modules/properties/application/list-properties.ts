import type { Property } from "../domain/property.js";
import type { ListPropertiesInput, PropertyRepository } from "./property-repository.js";

export type { ListPropertiesInput };

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
 * Lists properties in the already-resolved tenant's database, filtered/sorted/paginated per
 * `input`. `filters`/`sort`/`order` are passed straight through to the repository unchanged
 * (this task, section 29) — this use case never interprets a query string or builds SQL itself,
 * that already happened at the HTTP boundary (validation) and happens next in the repository
 * (predicate/order-by construction). `totalPages` is computed here, not by the repository, since
 * it is pure arithmetic over `total`/`limit` with no need for another round trip to the
 * database. With no filters, default sort (`created_at DESC, id DESC`) preserves the previous
 * unfiltered behavior exactly. `filters.query` (Prompt 025, full-text search) is likewise
 * already trimmed/length-validated and never parsed here — this use case has no idea whether
 * `input.sort` is a real column or the internal `"relevance"` value the HTTP layer resolves when
 * `q` is present without an explicit `sort` (see `PropertySort` in `property-repository.ts`).
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
