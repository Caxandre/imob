import { eq } from "drizzle-orm";
import type { Logger } from "pino";

import { controlPlaneDb } from "../infrastructure/database/control-plane/client.js";
import { databaseClusters } from "../infrastructure/database/control-plane/schema.js";
import type { SecretStore } from "../modules/provisioning/application/secret-store.js";

export interface LocalDevClusterBootstrapConfig {
  clusterName: string;
  host: string;
  port: number;
  adminUsername: string;
  adminPassword: string;
}

/**
 * DEV-ONLY (Prompt 024). `dev-full.ts` cannot provision a tenant at all until a matching,
 * `ACTIVE` `database_clusters` row exists (`TENANT_DATABASE_DEFAULT_CLUSTER`) and its admin
 * credential is loaded into the running process's `SecretStore` — previously a manual,
 * undocumented-in-code step (see ARCHITECTURE.md "Local development runtime" before this
 * task). This closes that gap for `dev-full.ts` specifically; `server.ts`,
 * `provisioning-worker.ts` and `provisioning-dispatcher.ts` are untouched and still require
 * both to be seeded manually when run as separate processes.
 *
 * Two different lifetimes are reconciled here on every call, deliberately with different
 * idempotency strategies:
 *  - `database_clusters` row: real PostgreSQL state, persists across `dev-full.ts` restarts.
 *    Idempotent by discovery (CLAUDE.md) — inserted only if missing (`onConflictDoNothing` on
 *    the unique `name`), never overwritten. An operator who already customized this row
 *    locally is never silently reset by a later `dev-full.ts` restart.
 *  - `SecretStore` entry: `createInMemorySecretStore()` starts empty on every process restart,
 *    even though the `database_clusters` row above survives it. So the admin credential is
 *    `put()` unconditionally on every call — that is what makes a restarted `dev-full.ts` able
 *    to provision again without a manual step, even though the row itself already existed.
 *
 * Never logs `config.adminPassword` (CLAUDE.md: never log secrets) — only the cluster's
 * non-secret identity (name/host/port).
 */
export async function bootstrapLocalDevCluster(
  secretStore: SecretStore,
  logger: Logger,
  config: LocalDevClusterBootstrapConfig,
): Promise<void> {
  const secretReference = `clusters/${config.clusterName}`;

  await controlPlaneDb
    .insert(databaseClusters)
    .values({
      name: config.clusterName,
      provider: "local",
      region: "local",
      status: "ACTIVE",
      host: config.host,
      port: config.port,
      secretReference,
    })
    .onConflictDoNothing({ target: databaseClusters.name });

  const [cluster] = await controlPlaneDb
    .select()
    .from(databaseClusters)
    .where(eq(databaseClusters.name, config.clusterName));

  if (!cluster) {
    throw new Error(
      `local dev cluster bootstrap: failed to create or find a database_clusters row named "${config.clusterName}"`,
    );
  }

  await secretStore.put(cluster.secretReference, {
    username: config.adminUsername,
    password: config.adminPassword,
  });

  logger.info(
    {
      operation: "dev-full.bootstrap-local-cluster",
      clusterName: cluster.name,
      host: cluster.host,
      port: cluster.port,
    },
    "local dev cluster ready (database_clusters row ensured, admin credential seeded into SecretStore)",
  );
}
