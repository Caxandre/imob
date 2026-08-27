import pino from "pino";

import { env } from "../config/env.js";
import { controlPlaneDb, controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createRedisConnection } from "../infrastructure/queue/redis-connection.js";
import { createClusterAdminCredentialResolver } from "../modules/provisioning/application/cluster-admin-credential-resolver.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import { createDrizzleDatabaseClusterSelector } from "../modules/provisioning/infrastructure/drizzle-database-cluster-selector.js";
import { createDrizzleProcessProvisioningJobRepository } from "../modules/provisioning/infrastructure/drizzle-process-provisioning-job-repository.js";
import { createPostgresDatabaseProvisioner } from "../modules/provisioning/infrastructure/postgres-database-provisioner.js";
import { createPostgresTenantDatabaseHealthChecker } from "../modules/provisioning/infrastructure/postgres-tenant-database-health-checker.js";
import { createPostgresTenantDatabaseProvisioner } from "../modules/provisioning/infrastructure/postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "../modules/provisioning/infrastructure/postgres-tenant-role-provisioner.js";
import { createInMemorySecretStore } from "../modules/provisioning/test-support/in-memory-secret-store.js";
import { createProvisioningWorker } from "../modules/provisioning/infrastructure/bullmq-provisioning-worker.js";

/**
 * Entrypoint for the provisioning worker (tenant-provisioning queue consumer).
 *
 * A real `DatabaseProvisioner` exists (Prompt 017) and the Control Plane finalization it
 * feeds is now implemented (Prompt 018) — the trava that used to refuse to start
 * unconditionally is gone. What remains is narrower and still real: no production-grade
 * `SecretStore` provider exists yet (AWS Secrets Manager, Vault, ...; see
 * `secret-store.ts`/ARCHITECTURE.md). `createInMemorySecretStore()` already refuses to
 * construct under `NODE_ENV=production` on its own, but this entrypoint checks explicitly
 * and fails fast with a clear reason *before* wiring anything — never silently falling back
 * to it in a real deployment. Outside of production (`development`/`test`), the worker
 * starts for real and processes jobs end to end against whatever `SecretStore`-shaped
 * storage is configured — in-memory today, a real provider whenever one is built.
 */
const logger = pino(createLoggerOptions());

if (env.NODE_ENV === "production") {
  logger.fatal(
    { operation: "provisioning-worker.startup", reason: "no-production-secret-store" },
    "Refusing to start in production: no production-grade SecretStore provider exists yet " +
      "(createInMemorySecretStore is test/dev support only, and refuses to construct under " +
      "NODE_ENV=production on its own). See " +
      "src/modules/provisioning/test-support/in-memory-secret-store.ts and ARCHITECTURE.md.",
  );
  process.exit(1);
}

const secretStore = createInMemorySecretStore();
const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
const clusterSelector = createDrizzleDatabaseClusterSelector(
  controlPlaneDb,
  env.TENANT_DATABASE_DEFAULT_CLUSTER,
);
const tenantRoleProvisioner = createPostgresTenantRoleProvisioner({
  secretStore,
  clusterAdminCredentialResolver,
});
const tenantDatabaseProvisioner = createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver });
const tenantDatabaseCredentialResolver = createTenantDatabaseCredentialResolver(secretStore);
const healthChecker = createPostgresTenantDatabaseHealthChecker();

const databaseProvisioner = createPostgresDatabaseProvisioner({
  clusterSelector,
  clusterAdminCredentialResolver,
  tenantRoleProvisioner,
  tenantDatabaseProvisioner,
  tenantDatabaseCredentialResolver,
  healthChecker,
});

const repository = createDrizzleProcessProvisioningJobRepository(controlPlaneDb);
const redisConnection = createRedisConnection();
const worker = createProvisioningWorker(redisConnection, repository, databaseProvisioner);

worker.on("completed", (job) => {
  logger.info(
    {
      operation: "provisioning-worker.job",
      provisioningJobId: job.data.provisioningJobId,
      tenantId: job.data.tenantId,
    },
    "provisioning job processed",
  );
});

worker.on("failed", (job, err) => {
  logger.error(
    {
      operation: "provisioning-worker.job",
      provisioningJobId: job?.data.provisioningJobId,
      tenantId: job?.data.tenantId,
      err,
    },
    "provisioning job processing failed",
  );
});

logger.info({ operation: "provisioning-worker.startup" }, "provisioning worker started");

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ operation: "provisioning-worker.shutdown", signal }, "shutdown requested");
  await worker.close();
  await redisConnection.quit();
  await controlPlanePool.end();
  logger.info({ operation: "provisioning-worker.shutdown" }, "shutdown complete");
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
