import { setTimeout as delay } from "node:timers/promises";

import pino from "pino";

import { env } from "../config/env.js";
import { controlPlaneDb, controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createRedisConnection } from "../infrastructure/queue/redis-connection.js";
import { createTenantProvisioningQueue } from "../infrastructure/queue/tenant-provisioning-queue.js";
import { dispatchProvisioningJobsOnce } from "../modules/provisioning/application/dispatch-provisioning-jobs.js";
import { createBullMqProvisioningJobPublisher } from "../modules/provisioning/infrastructure/bullmq-provisioning-job-publisher.js";
import { createDrizzleProvisioningDispatchRepository } from "../modules/provisioning/infrastructure/drizzle-provisioning-dispatch-repository.js";

const logger = pino(createLoggerOptions());

const redisConnection = createRedisConnection();
const queue = createTenantProvisioningQueue(redisConnection);
const repository = createDrizzleProvisioningDispatchRepository(controlPlaneDb);
const publisher = createBullMqProvisioningJobPublisher(queue);

let running = true;
const shutdownController = new AbortController();

function requestShutdown(signal: string): void {
  logger.info({ operation: "provisioning-dispatcher.shutdown", signal }, "shutdown requested");
  running = false;
  shutdownController.abort();
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

async function runLoop(): Promise<void> {
  while (running) {
    const cycleStartedAt = Date.now();
    logger.info({ operation: "provisioning-dispatcher.cycle" }, "dispatch cycle started");

    try {
      const summary = await dispatchProvisioningJobsOnce(repository, publisher, {
        batchSize: env.PROVISIONING_DISPATCH_BATCH_SIZE,
        leaseSeconds: env.PROVISIONING_DISPATCH_LEASE_SECONDS,
      });

      for (const result of summary.results) {
        const fields = {
          operation: "provisioning-dispatcher.job",
          provisioningJobId: result.id,
          tenantId: result.tenantId,
        };

        if (result.outcome === "dispatched") {
          logger.info(fields, "provisioning job dispatched");
        } else {
          logger.warn({ ...fields, err: result.error }, "provisioning job dispatch failed");
        }
      }

      logger.info(
        {
          operation: "provisioning-dispatcher.cycle",
          claimedCount: summary.claimedCount,
          durationMs: Date.now() - cycleStartedAt,
        },
        "dispatch cycle completed",
      );
    } catch (error) {
      // PostgreSQL/Redis unavailable at the claim stage itself: nothing was claimed, so
      // there is nothing to roll back. Log and retry on the next interval — a startup-time
      // configuration error already failed fast in config/env.ts, so this is always a
      // transient runtime condition.
      logger.error({ operation: "provisioning-dispatcher.cycle", err: error }, "dispatch cycle failed");
    }

    if (!running) {
      break;
    }

    try {
      await delay(env.PROVISIONING_DISPATCH_POLL_INTERVAL_MS, undefined, {
        signal: shutdownController.signal,
      });
    } catch {
      break; // Aborted by requestShutdown() — exit the loop immediately instead of waiting out the interval.
    }
  }
}

try {
  await runLoop();
} finally {
  await queue.close();
  await redisConnection.quit();
  await controlPlanePool.end();
  logger.info({ operation: "provisioning-dispatcher.shutdown" }, "shutdown complete");
}
