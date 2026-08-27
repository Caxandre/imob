import { grantTenantApplicationPrivileges } from "../../../infrastructure/database/tenant/permissions.js";
import { runTenantMigrations } from "../../../infrastructure/database/tenant/migrate.js";
import type { ClusterAdminCredentialResolver } from "../application/cluster-admin-credential-resolver.js";
import type { DatabaseClusterSelector } from "../application/database-cluster-selector.js";
import {
  DatabaseProvisioningError,
  type DatabaseProvisioner,
} from "../application/process-provisioning-job.js";
import type { ProvisioningResult } from "../application/provisioning-result.js";
import type { TenantDatabaseCredentialResolver } from "../application/tenant-database-credential-resolver.js";
import type { TenantDatabaseHealthChecker } from "../application/tenant-database-health-checker.js";
import type { TenantDatabaseProvisioner } from "../application/tenant-database-provisioner.js";
import type { TenantRoleProvisioner } from "../application/tenant-role-provisioner.js";

/**
 * Real, composed `DatabaseProvisioner` (ADR-003). Orchestrates the already-implemented,
 * independently-tested pieces from Prompts 011-015 in the order the ADR requires — it never
 * reimplements CREATE ROLE/CREATE DATABASE/GRANT/migration SQL itself:
 *
 * ```text
 * select cluster → ensure role → ensure database → run migrations → apply permissions
 *   → resolve tenant credential → health check → ProvisioningResult
 * ```
 *
 * Boundary (ADR-003 "Fronteira de responsabilidade", CLAUDE.md): this function only executes
 * and discovers external infrastructure and returns a result. It never writes to
 * `tenants`/`provisioning_jobs`/`tenant_databases` — persisting the result and finalizing the
 * workflow remains the application layer's responsibility (`processProvisioningJob`/worker,
 * not implemented here — see process-provisioning-job.ts).
 */
export function createPostgresDatabaseProvisioner(deps: {
  clusterSelector: DatabaseClusterSelector;
  clusterAdminCredentialResolver: ClusterAdminCredentialResolver;
  tenantRoleProvisioner: TenantRoleProvisioner;
  tenantDatabaseProvisioner: TenantDatabaseProvisioner;
  tenantDatabaseCredentialResolver: TenantDatabaseCredentialResolver;
  healthChecker: TenantDatabaseHealthChecker;
}): DatabaseProvisioner {
  return {
    async provision(input: { provisioningJobId: string; tenantId: string }): Promise<ProvisioningResult> {
      const { tenantId } = input;

      let cluster;
      try {
        cluster = await deps.clusterSelector.selectClusterFor(tenantId);
      } catch (error) {
        throw new DatabaseProvisioningError("Failed to select database cluster", { cause: error });
      }

      // Ordered as ADR-003 "Provisioning steps" requires: the role must exist before the
      // database is created/reconciled (TenantDatabaseProvisioner itself refuses to proceed
      // otherwise — Prompt 014).
      let roleName: string;
      let secretReference: string;
      try {
        ({ roleName, secretReference } = await deps.tenantRoleProvisioner.ensureRole({ tenantId, cluster }));
      } catch (error) {
        throw new DatabaseProvisioningError("Failed to create tenant credentials", { cause: error });
      }

      let databaseName: string;
      try {
        ({ databaseName } = await deps.tenantDatabaseProvisioner.ensureDatabase({ tenantId, cluster }));
      } catch (error) {
        throw new DatabaseProvisioningError("Failed to create tenant database", { cause: error });
      }

      // Migrations and permissions both run as the cluster administrative/migration
      // credential, resolved once and reused for both — the same connection target for
      // both calls, so "the role migrations run as" and "the role ALTER DEFAULT PRIVILEGES
      // was configured for" can never accidentally diverge (ADR-003, "Credentials and
      // secrets").
      let adminCredential;
      try {
        adminCredential = await deps.clusterAdminCredentialResolver.resolve(cluster.secretReference);
      } catch (error) {
        throw new DatabaseProvisioningError("Failed to resolve cluster administrative credential", {
          cause: error,
        });
      }
      const migrationTarget = {
        host: cluster.host,
        port: cluster.port,
        database: databaseName,
        user: adminCredential.username,
        password: adminCredential.password,
      };

      let schemaVersion: number;
      try {
        ({ schemaVersion } = await runTenantMigrations(migrationTarget));
      } catch (error) {
        throw new DatabaseProvisioningError("Failed to run tenant migrations", { cause: error });
      }

      try {
        await grantTenantApplicationPrivileges(migrationTarget, roleName);
      } catch (error) {
        throw new DatabaseProvisioningError("Failed to apply tenant database permissions", { cause: error });
      }

      // The health check authenticates as the tenant application role, never admin (ADR-003)
      // — its credential is resolved fresh here, independently of the role-provisioning step
      // above, the same "discover, never assume" idempotency every other step in this flow
      // already follows.
      let tenantCredential;
      try {
        tenantCredential = await deps.tenantDatabaseCredentialResolver.resolve(secretReference);
      } catch (error) {
        throw new DatabaseProvisioningError("Failed to resolve tenant database credential", { cause: error });
      }

      try {
        await deps.healthChecker.check({
          cluster,
          databaseName,
          credential: tenantCredential,
          expectedSchemaVersion: schemaVersion,
        });
      } catch (error) {
        throw new DatabaseProvisioningError("Failed tenant database health check", { cause: error });
      }

      return {
        clusterId: cluster.id,
        databaseName,
        secretReference,
        schemaVersion,
      };
    },
  };
}
