import type { TenantDatabaseDetails, TenantDatabaseSummary } from "./tenant-database-summary.js";
import type { ProvisioningJobSummary } from "./tenant-provisioning-job-summary.js";

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

/**
 * A tenant as returned by the administrative details endpoint (Prompt 034) — the plain
 * `Tenant` plus its database (with timestamps, unlike the listing's summary) and its most
 * recent provisioning job. Both are `null` exactly when no corresponding row exists yet (this
 * task, sections 8/13) — never an artificial/synthesized object, and never a 404 just because
 * one of these is absent (only a missing tenant itself is a 404).
 */
export interface TenantDetails extends Tenant {
  database: TenantDatabaseDetails | null;
  latestProvisioningJob: ProvisioningJobSummary | null;
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

/** Raised when no tenant with the given id exists. Maps to HTTP 404 at the edge. */
export class TenantNotFoundError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string) {
    super(`Tenant "${tenantId}" was not found`);
    this.name = "TenantNotFoundError";
    this.tenantId = tenantId;
  }
}
