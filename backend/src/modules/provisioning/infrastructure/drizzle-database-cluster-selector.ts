import { and, eq } from "drizzle-orm";

import type { ControlPlaneDatabase } from "../../../infrastructure/database/control-plane/client.js";
import { databaseClusters } from "../../../infrastructure/database/control-plane/schema.js";
import type {
  DatabaseCluster,
  DatabaseClusterSelector,
} from "../application/database-cluster-selector.js";
import { DatabaseClusterNotAvailableError } from "../application/database-cluster-selector.js";

/**
 * Resolves the configured default cluster (TENANT_DATABASE_DEFAULT_CLUSTER) by name,
 * requiring it to be ACTIVE. Ignores tenantId for now — every tenant currently lands on
 * the same cluster; per-tenant assignment strategies are future work.
 */
export function createDrizzleDatabaseClusterSelector(
  db: ControlPlaneDatabase,
  defaultClusterName: string,
): DatabaseClusterSelector {
  return {
    async selectClusterFor(_tenantId: string): Promise<DatabaseCluster> {
      const [row] = await db
        .select()
        .from(databaseClusters)
        .where(
          and(eq(databaseClusters.name, defaultClusterName), eq(databaseClusters.status, "ACTIVE")),
        );

      if (!row) {
        throw new DatabaseClusterNotAvailableError(defaultClusterName);
      }

      return {
        id: row.id,
        name: row.name,
        provider: row.provider,
        region: row.region,
        secretReference: row.secretReference,
      };
    },
  };
}
