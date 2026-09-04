import type { Tenant, TenantListItem, TenantStatus } from "../domain/tenant.js";

export interface CreateTenantInput {
  name: string;
  slug: string;
}

/**
 * Structured filters for `GET /api/v1/tenants` (Prompt 033) — both optional, AND-combined, the
 * same convention as `PropertyListFilters`. `query` is already trimmed/length-validated by the
 * HTTP boundary (`list-tenants.schema.ts`) — the repository only ever receives a non-empty
 * string here, matched case-insensitively as a substring against `name`/`slug` (`ILIKE
 * '%...%'`) — never full-text search (this task, section 7).
 */
export interface TenantListFilters {
  status?: TenantStatus;
  query?: string;
}

export interface ListTenantsInput {
  page: number;
  limit: number;
  filters: TenantListFilters;
}

export interface ListTenantsResult {
  data: TenantListItem[];
  total: number;
}

/**
 * Persistence port for the Tenants module. `createWithProvisioningIntent` must persist the
 * tenant together with the intent to provision its database (a PENDING `provisioning_jobs`
 * row) as a single atomic operation — see `create-tenant.ts`. `list` reads exclusively from the
 * Control Plane (`tenants` LEFT JOIN `tenant_databases` LEFT JOIN `database_clusters`, this
 * task, sections 11/12/31) — it never opens a connection to any tenant's own database.
 */
export interface TenantRepository {
  /** Throws {@link TenantSlugAlreadyExistsError} when the slug is taken. */
  createWithProvisioningIntent(input: CreateTenantInput): Promise<Tenant>;
  list(input: ListTenantsInput): Promise<ListTenantsResult>;
}
