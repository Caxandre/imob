import type { TenantStatus } from "../../tenants/domain/tenant.js";

/**
 * Everything the runtime needs to open a connection to a tenant's physical database — never a
 * password (ADR-003/CLAUDE.md: a credential only ever exists in memory, resolved separately
 * from `secretReference` at the point of connection). Always sourced from `tenant_databases`
 * (ADR-001/CLAUDE.md): naming may be deterministic today (`buildProvisioningResourceNames`),
 * but `tenant_databases` is the authoritative record of which infrastructure is actually
 * active for a tenant — the runtime never derives it directly from `tenantId`/`slug`.
 */
export interface TenantDatabaseTarget {
  tenantId: string;
  clusterId: string;
  host: string;
  port: number;
  databaseName: string;
  secretReference: string;
  schemaVersion: number;
}

/**
 * Raised when the tenant itself is not in a state that permits normal application runtime
 * access — missing entirely, or any status other than `READY` (`PROVISIONING`, `FAILED`,
 * `SUSPENDED`). `status` is `"NOT_FOUND"` when no tenant with that id exists at all. Never
 * reveals anything beyond the tenantId and the status found.
 */
export class TenantNotReadyError extends Error {
  readonly tenantId: string;
  readonly status: TenantStatus | "NOT_FOUND";

  constructor(tenantId: string, status: TenantStatus | "NOT_FOUND") {
    super(`Tenant "${tenantId}" is not READY (status: ${status})`);
    this.name = "TenantNotReadyError";
    this.tenantId = tenantId;
    this.status = status;
  }
}

/**
 * Raised when the tenant itself is `READY` but its registered database is not — missing
 * entirely, or `tenant_databases.status` other than `READY`. Through the normal provisioning
 * flow this should never happen (both are set atomically in the same transaction — ADR-003
 * "Finalization"), but the runtime must still verify and refuse rather than assume the
 * invariant always holds (e.g. a manual/operational change to `tenant_databases` alone).
 */
export class TenantDatabaseNotAvailableError extends Error {
  readonly tenantId: string;
  readonly status: string;

  constructor(tenantId: string, status: string) {
    super(`Tenant database for "${tenantId}" is not available (status: ${status})`);
    this.name = "TenantDatabaseNotAvailableError";
    this.tenantId = tenantId;
    this.status = status;
  }
}

/**
 * Raised when the tenant's registered database points at infrastructure that is not currently
 * usable — today, only an `INACTIVE` cluster (never auto-selects a different one). Deliberately
 * distinct from the two errors above: this is a platform/infrastructure configuration problem,
 * not a tenant lifecycle state.
 */
export class TenantDatabaseRuntimeConfigurationError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string, reason: string) {
    super(`Tenant database runtime configuration problem for "${tenantId}": ${reason}`);
    this.name = "TenantDatabaseRuntimeConfigurationError";
    this.tenantId = tenantId;
  }
}

/**
 * Resolves which physical database a tenant's runtime traffic should use, straight from the
 * Control Plane (`tenants` → `tenant_databases` → `database_clusters`) on every call —
 * deliberately never cached across calls. A tenant suspended after a connection was already
 * established must still be re-checked the next time this is called: authorization here is
 * never assumed to remain valid indefinitely (ADR-001/ADR-003).
 */
export interface TenantDatabaseResolver {
  resolve(tenantId: string): Promise<TenantDatabaseTarget>;
}
