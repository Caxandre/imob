import type { DatabaseCluster } from "./database-cluster-selector.js";

/**
 * Ensures a tenant's PostgreSQL database exists on the given cluster, with CONNECT revoked
 * from PUBLIC and granted only to the tenant's application role — idempotently. Requires the
 * tenant's application role to already exist (see TenantRoleProvisioner); never creates it.
 * Never runs tenant migrations, grants table/schema privileges, or performs a health check —
 * those remain separate provisioning steps (ADR-003).
 */
export interface TenantDatabaseProvisioner {
  ensureDatabase(input: { tenantId: string; cluster: DatabaseCluster }): Promise<{ databaseName: string }>;
}

/**
 * Raised when the tenant's application role does not exist yet. Database creation is refused
 * rather than silently creating the role — TenantRoleProvisioner.ensureRole() must run first
 * (ADR-003 orders role provisioning before database provisioning).
 */
export class TenantApplicationRoleNotFoundError extends Error {
  constructor(roleName: string) {
    super(`Tenant application role "${roleName}" does not exist; run role provisioning first`);
    this.name = "TenantApplicationRoleNotFoundError";
  }
}

/**
 * Wraps a failed CREATE DATABASE/REVOKE/GRANT against the cluster. Never carries the raw
 * driver error message on `.message` — the original error is preserved only on `.cause`, for
 * structured logging, never for display.
 */
export class TenantDatabaseProvisioningError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "TenantDatabaseProvisioningError";
  }
}
