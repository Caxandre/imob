import { setTimeout as delay } from "node:timers/promises";

import type { Logger } from "pino";

import { env } from "../config/env.js";
import { controlPlaneDb } from "../infrastructure/database/control-plane/client.js";
import { createRedisConnection } from "../infrastructure/queue/redis-connection.js";
import { createClusterAdminCredentialResolver } from "../modules/provisioning/application/cluster-admin-credential-resolver.js";
import type { DatabaseProvisioner, ProcessProvisioningJobRepository, ProvisioningExecutionOptions } from "../modules/provisioning/application/process-provisioning-job.js";
import { recoverExpiredRunningJobsOnce } from "../modules/provisioning/application/recover-provisioning-jobs.js";
import type { SecretStore } from "../modules/provisioning/application/secret-store.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import { createDrizzleDatabaseClusterSelector } from "../modules/provisioning/infrastructure/drizzle-database-cluster-selector.js";
import { createDrizzleProcessProvisioningJobRepository } from "../modules/provisioning/infrastructure/drizzle-process-provisioning-job-repository.js";
import { createPostgresDatabaseProvisioner } from "../modules/provisioning/infrastructure/postgres-database-provisioner.js";
import { createPostgresTenantDatabaseHealthChecker } from "../modules/provisioning/infrastructure/postgres-tenant-database-health-checker.js";
import { createPostgresTenantDatabaseProvisioner } from "../modules/provisioning/infrastructure/postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "../modules/provisioning/infrastructure/postgres-tenant-role-provisioner.js";
import { createProvisioningWorker } from "../modules/provisioning/infrastructure/bullmq-provisioning-worker.js";

/**
 * Composes the provisioning worker's full dependency pipeline (BullMQ `Worker` + the real
 * `DatabaseProvisioner` + the independent RUNNING-recovery loop, ADR-003 Prompts 017-019) and
 * returns a handle to it. Extracted out of `provisioning-worker.ts` (this task, Prompt 021,
 * section 33-36's local dev secret-sharing decision) so both the standalone worker entrypoint
 * and the dev-only combined runtime (`src/main/dev-full.ts`) can build the exact same pipeline
 * from a `SecretStore` instance the *caller* provides — never constructed internally — which
 * is exactly what lets `dev-full.ts` hand this the same in-memory `SecretStore` instance the
 * HTTP API side also uses, closing the cross-process secret-sharing gap for local development.
 *
 * Deliberately does NOT include: the `NODE_ENV=production` fail-fast (every entrypoint that
 * calls this must perform its own explicit check first — this task's section 2 requirement
 * that a combined entrypoint have its own clear fail-fast, not rely solely on a shared
 * helper), `pino()` construction (the caller's logger is passed in), signal handlers, or
 * `controlPlanePool` lifecycle (every caller already imports the same pool singleton directly
 * and is responsible for closing it itself, exactly once, after this runtime's own
 * `shutdown()` resolves).
 */
export interface ProvisioningWorkerRuntime {
  worker: ReturnType<typeof createProvisioningWorker>;
  repository: ProcessProvisioningJobRepository;
  databaseProvisioner: DatabaseProvisioner;
  shutdown(): Promise<void>;
}

export function createProvisioningWorkerRuntime(
  secretStore: SecretStore,
  logger: Logger,
): ProvisioningWorkerRuntime {
  const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
  const clusterSelector = createDrizzleDatabaseClusterSelector(
    controlPlaneDb,
    env.TENANT_DATABASE_DEFAULT_CLUSTER,
  );
  const tenantRoleProvisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
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
  // PROVISIONING_EXECUTION_HEARTBEAT_INTERVAL_MS for every in-flight job would be pure noise.
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
  // dependency on BullMQ (ADR-003 "Recovery": recovery never redispatches through the queue,
  // it resumes execution of an already-RUNNING job directly).
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

  return {
    worker,
    repository,
    databaseProvisioner,
    async shutdown(): Promise<void> {
      recoveryRunning = false;
      recoveryShutdownController.abort();
      await recoveryLoopPromise;
      await worker.close();
      await redisConnection.quit();
    },
  };
}
