import { eq } from "drizzle-orm";

import type { ControlPlaneDatabase } from "../../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import {
  TenantDatabaseNotAvailableError,
  TenantDatabaseRuntimeConfigurationError,
  TenantNotReadyError,
} from "../application/tenant-database-resolver.js";
import type {
  TenantDatabaseResolver,
  TenantDatabaseTarget,
} from "../application/tenant-database-resolver.js";

/**
 * Real, Control Plane-backed `TenantDatabaseResolver`. Three sequential lookups — `tenants` →
 * `tenant_databases` → `database_clusters` — rather than a single outer-joined query: every
 * column read here needs to be trusted as non-null once its own guard has passed, and a plain
 * per-table `SELECT ... WHERE` gives that for free without non-null assertions a LEFT JOIN's
 * always-nullable projected columns would otherwise require. Each lookup is a cheap,
 * already-indexed point read (`tenants.id`/`tenant_databases.tenant_id`/`database_clusters.id`
 * are the primary key or a unique constraint) — an acceptable cost for a boundary that must
 * never trust a cached or assumed status.
 */
export function createDrizzleTenantDatabaseResolver(db: ControlPlaneDatabase): TenantDatabaseResolver {
  return {
    async resolve(tenantId: string): Promise<TenantDatabaseTarget> {
      const [tenant] = await db
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId));

      if (!tenant) {
        throw new TenantNotReadyError(tenantId, "NOT_FOUND");
      }
      if (tenant.status !== "READY") {
        throw new TenantNotReadyError(tenantId, tenant.status);
      }

      const [tenantDatabase] = await db
        .select({
          clusterId: tenantDatabases.clusterId,
          databaseName: tenantDatabases.databaseName,
          secretReference: tenantDatabases.secretReference,
          schemaVersion: tenantDatabases.schemaVersion,
          status: tenantDatabases.status,
        })
        .from(tenantDatabases)
        .where(eq(tenantDatabases.tenantId, tenantId));

      if (!tenantDatabase || tenantDatabase.status !== "READY") {
        throw new TenantDatabaseNotAvailableError(tenantId, tenantDatabase?.status ?? "MISSING");
      }

      const [cluster] = await db
        .select({ status: databaseClusters.status, host: databaseClusters.host, port: databaseClusters.port })
        .from(databaseClusters)
        .where(eq(databaseClusters.id, tenantDatabase.clusterId));

      if (!cluster) {
        // Unreachable through normal provisioning — tenant_databases.cluster_id has a NOT
        // NULL FK to database_clusters — guarded defensively rather than assumed.
        throw new TenantDatabaseRuntimeConfigurationError(
          tenantId,
          "no cluster is registered for this tenant database",
        );
      }
      if (cluster.status !== "ACTIVE") {
        throw new TenantDatabaseRuntimeConfigurationError(tenantId, `cluster is ${cluster.status}, not ACTIVE`);
      }

      return {
        tenantId,
        clusterId: tenantDatabase.clusterId,
        host: cluster.host,
        port: cluster.port,
        databaseName: tenantDatabase.databaseName,
        secretReference: tenantDatabase.secretReference,
        schemaVersion: tenantDatabase.schemaVersion,
      };
    },
  };
}
