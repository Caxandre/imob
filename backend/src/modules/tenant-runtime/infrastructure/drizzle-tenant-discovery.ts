import { and, asc, eq, gt, type SQL } from "drizzle-orm";

import type { ControlPlaneDatabase } from "../../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import type { ListReadyTenantIdsInput, TenantDiscovery } from "../application/tenant-discovery.js";

/**
 * Real, Control Plane-backed `TenantDiscovery`. A single joined query rather than
 * `TenantDatabaseResolver`'s three sequential lookups (this task) — that resolver optimizes for
 * "trust each column as non-null once its own guard passed" on a single tenant; this listing
 * only ever needs the id of a row that already satisfies all three conditions, so one INNER JOIN
 * across all three eligibility predicates is both simpler and cheaper for a page of many rows.
 */
export function createDrizzleTenantDiscovery(db: ControlPlaneDatabase): TenantDiscovery {
  return {
    async listReadyTenantIds({ after, limit }: ListReadyTenantIdsInput): Promise<string[]> {
      const conditions: SQL[] = [
        eq(tenants.status, "READY"),
        eq(tenantDatabases.status, "READY"),
        eq(databaseClusters.status, "ACTIVE"),
      ];
      if (after !== undefined) {
        conditions.push(gt(tenants.id, after));
      }

      const rows = await db
        .select({ id: tenants.id })
        .from(tenants)
        .innerJoin(tenantDatabases, eq(tenantDatabases.tenantId, tenants.id))
        .innerJoin(databaseClusters, eq(databaseClusters.id, tenantDatabases.clusterId))
        .where(and(...conditions))
        .orderBy(asc(tenants.id))
        .limit(limit);

      return rows.map((row) => row.id);
    },
  };
}
