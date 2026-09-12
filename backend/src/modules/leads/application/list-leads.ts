import type { LeadWithPropertySummary } from "../domain/lead-property-summary.js";
import type { LeadRepository, ListLeadsInput } from "./lead-repository.js";

export type { ListLeadsInput } from "./lead-repository.js";

export interface ListLeadsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ListLeadsOutput {
  data: LeadWithPropertySummary[];
  pagination: ListLeadsPagination;
}

/**
 * Lists leads in the already-resolved tenant's database, filtered/sorted/paginated per `input`
 * — pass-through to the repository, same shape as `listProperties`. `totalPages` is pure
 * arithmetic over `total`/`limit`, computed here rather than by the repository.
 */
export async function listLeads(repository: LeadRepository, input: ListLeadsInput): Promise<ListLeadsOutput> {
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
