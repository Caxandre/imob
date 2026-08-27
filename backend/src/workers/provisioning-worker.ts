import { setTimeout as delay } from "node:timers/promises";

import pino from "pino";

import { env } from "../config/env.js";
import { controlPlaneDb, controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createRedisConnection } from "../infrastructure/queue/redis-connection.js";
import { createClusterAdminCredentialResolver } from "../modules/provisioning/application/cluster-admin-credential-resolver.js";
import type { ProvisioningExecutionOptions } from "../modules/provisioning/application/process-provisioning-job.js";
import { recoverExpiredRunningJobsOnce } from "../modules/provisioning/application/recover-provisioning-jobs.js";
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
 * Entrypoint for the provisioning worker (tenant-provisioning queue consumer), plus a
 * separate, independent recovery loop for `RUNNING` jobs abandoned by a worker that died
 * mid-execution (ADR-003 "Recovery", Prompt 019) — the same process, deliberately two
 * distinct components (this task, section 42): the BullMQ `Worker` below only ever consumes
 * fresh deliveries, and never claims abandoned jobs itself.
 *
 * A real `DatabaseProvisioner` exists (Prompt 017) and the Control Plane finalization it
 * feeds is implemented (Prompt 018) — the trava that used to refuse to start unconditionally
 * is gone. What remains is narrower and still real: no production-grade `SecretStore`
 * provider exists yet (AWS Secrets Manager, Vault, ...; see `secret-store.ts`/
 * ARCHITECTURE.md). `createInMemorySecretStore()` already refuses to construct under
 * `NODE_ENV=production` on its own, but this entrypoint checks explicitly and fails fast
 * with a clear reason *before* wiring anything — never silently falling back to it in a real
 * deployment. Outside of production (`development`/`test`), the worker starts for real and
 * processes jobs end to end against whatever `SecretStore`-shaped storage is configured —
 * in-memory today, a real provider whenever one is built. Recovery working does not change
 * this: it depends on the same `DatabaseProvisioner`/`SecretStore`, not a separate one.
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

// Only ownership loss and renewal errors are logged — a routine successful renewal every
// PROVISIONING_EXECUTION_HEARTBEAT_INTERVAL_MS for every in-flight job would be pure noise
// (this task, section 52's "acceptable logs" is not a mandate to log every tick).
const executionOptions: ProvisioningExecutionOptions = {
  leaseSeconds: env.PROVISIONING_EXECUTION_LEASE_SECONDS,
  heartbeatIntervalMs: env.PROVISIONING_EXECUTION_HEARTBEAT_INTERVAL_MS,
  onHeartbeatEvent: (event) => {
    if (event.type === "ownership-lost") {
      logger.warn({ operation: "provisioning-worker.heartbeat" }, "execution lease ownership lost");
    } else if (event.type === "renewal-error") {
      logger.error(
        { operation: "provisioning-worker.heartbeat", err: event.error },
        "execution lease renewal failed (transient — will retry on the next tick)",
      );
    }
  },
};

const redisConnection = createRedisConnection();
const worker = createProvisioningWorker(redisConnection, repository, databaseProvisioner, executionOptions);

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

// Independent recovery loop — its own polling cadence, its own shutdown signal, no
// dependency on BullMQ (ADR-003 "Recovery", section 43: recovery never redispatches through
// the queue, it resumes execution of an already-RUNNING job directly).
let recoveryRunning = true;
const recoveryShutdownController = new AbortController();

async function runRecoveryLoop(): Promise<void> {
  while (recoveryRunning) {
    try {
      const summary = await recoverExpiredRunningJobsOnce(repository, databaseProvisioner, {
        batchSize: env.PROVISIONING_RECOVERY_BATCH_SIZE,
        leaseSeconds: env.PROVISIONING_EXECUTION_LEASE_SECONDS,
        heartbeatIntervalMs: env.PROVISIONING_EXECUTION_HEARTBEAT_INTERVAL_MS,
        onHeartbeatEvent: executionOptions.onHeartbeatEvent,
      });

      for (const result of summary.results) {
        const fields = {
          operation: "provisioning-worker.recovery",
          provisioningJobId: result.id,
          tenantId: result.tenantId,
        };

        if (result.error) {
          logger.error({ ...fields, err: result.error }, "recovered provisioning job execution failed");
        } else {
          logger.info({ ...fields, outcome: result.outcome }, "recovered abandoned provisioning job");
        }
      }

      if (summary.claimedCount > 0) {
        logger.info(
          { operation: "provisioning-worker.recovery", claimedCount: summary.claimedCount },
          "recovery cycle claimed abandoned jobs",
        );
      }
    } catch (error) {
      // PostgreSQL unavailable at the claim stage itself: nothing was claimed, nothing to
      // roll back. Log and retry on the next interval.
      logger.error({ operation: "provisioning-worker.recovery", err: error }, "recovery cycle failed");
    }

    if (!recoveryRunning) {
      break;
    }

    try {
      await delay(env.PROVISIONING_RECOVERY_POLL_INTERVAL_MS, undefined, {
        signal: recoveryShutdownController.signal,
      });
    } catch {
      break; // Aborted by shutdown() — exit the loop immediately instead of waiting out the interval.
    }
  }
}

const recoveryLoopPromise = runRecoveryLoop();

logger.info({ operation: "provisioning-worker.startup" }, "provisioning worker started");

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ operation: "provisioning-worker.shutdown", signal }, "shutdown requested");
  recoveryRunning = false;
  recoveryShutdownController.abort();
  await recoveryLoopPromise;
  await worker.close();
  await redisConnection.quit();
  await controlPlanePool.end();
  logger.info({ operation: "provisioning-worker.shutdown" }, "shutdown complete");
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
