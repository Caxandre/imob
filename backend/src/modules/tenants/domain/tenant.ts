import type { TenantDatabaseSummary } from "./tenant-database-summary.js";

export type TenantStatus = "PROVISIONING" | "READY" | "FAILED" | "SUSPENDED";

/**
 * Tenant as the application layer sees it. Kept free of Drizzle/PostgreSQL types so business
 * code does not depend on how (or where) the Control Plane stores it.
 */
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A tenant as returned by the administrative listing (Prompt 033) — the plain `Tenant` plus a
 * summary of its registered database/cluster, joined in from the Control Plane. `database` is
 * `null` exactly when no `tenant_databases` row exists yet for this tenant (this task, section
 * 15) — a normal, expected state for a tenant still `PROVISIONING` or in any inconsistent state,
 * never an artificial/synthesized object.
 */
export interface TenantListItem extends Tenant {
  database: TenantDatabaseSummary | null;
}

/** Raised when a tenant with the same slug already exists. Maps to HTTP 409 at the edge. */
export class TenantSlugAlreadyExistsError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`A tenant with slug "${slug}" already exists`);
    this.name = "TenantSlugAlreadyExistsError";
    this.slug = slug;
  }
}
