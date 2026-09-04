import type { TenantListItem } from "../domain/tenant.js";
import type { ListTenantsInput, TenantRepository } from "./tenant-repository.js";

export type { ListTenantsInput };

export interface ListTenantsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ListTenantsOutput {
  data: TenantListItem[];
  pagination: ListTenantsPagination;
}

/**
 * Lists tenants from the Control Plane, filtered/paginated per `input` — mirrors
 * `listProperties()` exactly (this task, section 25): never interprets a query string or
 * builds SQL itself (already done at the HTTP boundary and in the repository, respectively),
 * `totalPages` is pure arithmetic over `total`/`limit`. Ordering is fixed
 * (`created_at DESC, id DESC`, this task, section 10) — there is no `sort` input to pass
 * through yet.
 */
export async function listTenants(
  repository: TenantRepository,
  input: ListTenantsInput,
): Promise<ListTenantsOutput> {
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
