import { setTimeout as delay } from "node:timers/promises";

import type { Logger } from "pino";

import { env } from "../config/env.js";
import { controlPlaneDb } from "../infrastructure/database/control-plane/client.js";
import { createMediaProcessingQueue, type MediaProcessingQueue } from "../infrastructure/queue/media-processing-queue.js";
import { createRedisConnection } from "../infrastructure/queue/redis-connection.js";
import {
  runMediaOutboxDispatchCycleOnce,
  type MediaOutboxDispatchCycleDeps,
  type MediaOutboxDispatchCycleOptions,
} from "../modules/media-processing/application/dispatch-media-outbox-cycle.js";
import { createBullMqMediaOutboxJobPublisher } from "../modules/media-processing/infrastructure/bullmq-media-outbox-job-publisher.js";
import { createDrizzleMediaOutboxDispatchRepository } from "../modules/media-processing/infrastructure/drizzle-media-outbox-dispatch-repository.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import type { SecretStore } from "../modules/provisioning/application/secret-store.js";
import { createDrizzleTenantDatabaseResolver } from "../modules/tenant-runtime/infrastructure/drizzle-tenant-database-resolver.js";
import { createDrizzleTenantDiscovery } from "../modules/tenant-runtime/infrastructure/drizzle-tenant-discovery.js";
import { createPgTenantDatabaseConnectionManager } from "../modules/tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";

/**
 * Composes the media outbox dispatcher's full pipeline (Prompt 031, ADR-009) and returns a
 * handle to it — same extraction pattern as `provisioning-worker-runtime.ts`
 * (`createProvisioningWorkerRuntime`), and for the identical reason: this dispatcher needs to
 * resolve *tenant application* credentials (to open each tenant's own Tenant Data Plane database
 * and claim its `outbox_events`), so it receives its `SecretStore` from the caller rather than
 * constructing one internally — that is what lets `src/main/dev-full.ts` hand this the *same*
 * in-memory `SecretStore` instance the provisioning worker already writes tenant secrets into,
 * closing the same cross-process gap already documented for provisioning-worker.ts vs
 * server.ts (see ARCHITECTURE.md "Local development runtime").
 *
 * Deliberately does NOT include: the `NODE_ENV=production` fail-fast (the caller performs its
 * own explicit check first, same convention as `createProvisioningWorkerRuntime`), `pino()`
 * construction, signal handlers, or `controlPlanePool` lifecycle.
 */
export interface MediaOutboxDispatcherRuntime {
  shutdown(): Promise<void>;
}

export function createMediaOutboxDispatcherRuntime(
  secretStore: SecretStore,
  logger: Logger,
): MediaOutboxDispatcherRuntime {
  const tenantDiscovery = createDrizzleTenantDiscovery(controlPlaneDb);
  const tenantDatabaseResolver = createDrizzleTenantDatabaseResolver(controlPlaneDb);
  const tenantDatabaseConnectionManager = createPgTenantDatabaseConnectionManager({
    credentialResolver: createTenantDatabaseCredentialResolver(secretStore),
  });

  const redisConnection = createRedisConnection();
  const queue: MediaProcessingQueue = createMediaProcessingQueue(redisConnection);
  const publisher = createBullMqMediaOutboxJobPublisher(queue);

  const deps: MediaOutboxDispatchCycleDeps = {
    tenantDiscovery,
    tenantDatabaseResolver,
    tenantDatabaseConnectionManager,
    createRepository: createDrizzleMediaOutboxDispatchRepository,
    publisher,
  };

  const cycleOptions: MediaOutboxDispatchCycleOptions = {
    tenantBatchSize: env.MEDIA_OUTBOX_DISPATCH_TENANT_BATCH_SIZE,
    eventBatchSize: env.MEDIA_OUTBOX_DISPATCH_EVENT_BATCH_SIZE,
    leaseSeconds: env.MEDIA_OUTBOX_DISPATCH_LEASE_SECONDS,
    concurrency: env.MEDIA_OUTBOX_DISPATCH_CONCURRENCY,
  };

  let running = true;
  // In-memory only, never persisted (this task, section 7) — losing it on restart just
  // restarts the tenant scan from the beginning next cycle; the durable source of truth is
  // the pending outbox rows themselves, never this cursor.
  let cursor: string | undefined;
  const shutdownController = new AbortController();

  async function runLoop(): Promise<void> {
    while (running) {
      const cycleStartedAt = Date.now();

      try {
        const summary = await runMediaOutboxDispatchCycleOnce(deps, cursor, cycleOptions);
        cursor = summary.nextCursor;

        for (const tenantResult of summary.tenantResults) {
          if (tenantResult.outcome === "tenant-unavailable") {
            // A single tenant being temporarily unreachable (secret gap, INACTIVE cluster,
            // connection failure, ...) never aborts the cycle (section 31/49/61) — logged and
            // skipped, retried again next cycle.
            logger.warn(
              {
                operation: "media-outbox-dispatcher.tenant",
                tenantId: tenantResult.tenantId,
                err: tenantResult.error,
              },
              "tenant temporarily unavailable for media outbox dispatch — skipped this cycle",
            );
            continue;
          }

          for (const eventResult of tenantResult.summary?.results ?? []) {
            const fields = {
              operation: "media-outbox-dispatcher.event",
              tenantId: tenantResult.tenantId,
              outboxEventId: eventResult.outboxEventId,
            };
            if (eventResult.outcome === "dispatched") {
              logger.info(fields, "media outbox event dispatched");
            } else if (eventResult.outcome === "invalid") {
              logger.warn(fields, "media outbox event payload invalid — marked dispatch_failed, never sent");
            } else {
              logger.warn(
                { ...fields, err: eventResult.error },
                "media outbox event dispatch failed — lease released for retry",
              );
            }
          }
        }

        logger.info(
          {
            operation: "media-outbox-dispatcher.cycle",
            tenantCount: summary.tenantIds.length,
            durationMs: Date.now() - cycleStartedAt,
          },
          "media outbox dispatch cycle completed",
        );
      } catch (error) {
        // Control Plane unreachable at the tenant-discovery stage itself: nothing was
        // claimed anywhere this cycle, so there is nothing to roll back. Log and retry on the
        // next interval.
        logger.error(
          { operation: "media-outbox-dispatcher.cycle", err: error },
          "media outbox dispatch cycle failed",
        );
      }

      if (!running) {
        break;
      }

      try {
        await delay(env.MEDIA_OUTBOX_DISPATCH_POLL_INTERVAL_MS, undefined, {
          signal: shutdownController.signal,
        });
      } catch {
        break; // Aborted by shutdown() — exit the loop immediately instead of waiting out the interval.
      }
    }
  }

  const loopPromise = runLoop();

  return {
    async shutdown(): Promise<void> {
      running = false;
      shutdownController.abort();
      await loopPromise;
      await queue.close();
      await redisConnection.quit();
    },
  };
}
