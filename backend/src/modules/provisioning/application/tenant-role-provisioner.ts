import type { DatabaseCluster } from "./database-cluster-selector.js";

/**
 * Ensures a tenant's PostgreSQL application role exists on the given cluster, with a valid
 * credential saved under the tenant's deterministic secretReference — idempotently. Never
 * creates the tenant's database, grants privileges, runs migrations, or performs a health
 * check; those remain separate provisioning steps (ADR-003).
 */
export interface TenantRoleProvisioner {
  ensureRole(input: {
    tenantId: string;
    cluster: DatabaseCluster;
  }): Promise<{ roleName: string; secretReference: string }>;
}

/**
 * Raised when a value exists at the tenant's secretReference but fails validation against
 * `tenantDatabaseCredentialSchema`. Deliberately does not overwrite the secret or touch the
 * role when this happens — an invalid stored secret is treated as an operational
 * inconsistency to surface, not evidence to silently discard. Never includes the payload or
 * the Zod issue values — only the reference and the field paths that failed.
 */
export class InvalidTenantSecretError extends Error {
  constructor(secretReference: string, invalidPaths: string[]) {
    super(
      `Tenant database secret at reference "${secretReference}" failed validation (fields: ${invalidPaths.join(", ") || "unknown"})`,
    );
    this.name = "InvalidTenantSecretError";
  }
}

/**
 * Wraps a failed CREATE ROLE/ALTER ROLE against the cluster. Never carries the raw driver
 * error message on `.message` — a PostgreSQL syntax-error message can, in principle, echo a
 * fragment of the failing statement text, and that statement embeds the tenant password
 * literal (see "CREATE ROLE"/"ALTER ROLE" in the implementation for why a bind parameter
 * isn't available there). The original error is preserved only on `.cause`, for structured
 * logging, never for display.
 */
export class TenantRoleProvisioningError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "TenantRoleProvisioningError";
  }
}
