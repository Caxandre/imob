import type { Logger } from "pino";

import { env } from "../config/env.js";
import { controlPlaneDb } from "../infrastructure/database/control-plane/client.js";
import type { ObjectStorage } from "../infrastructure/object-storage/object-storage.js";
import { createRedisConnection } from "../infrastructure/queue/redis-connection.js";
import { createMediaProcessingWorker } from "../modules/media-processing/infrastructure/bullmq-media-processing-worker.js";
import { createSharpImageVariantProcessor } from "../modules/media-processing/infrastructure/sharp-image-variant-processor.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import type { SecretStore } from "../modules/provisioning/application/secret-store.js";
import { createDrizzleTenantDatabaseResolver } from "../modules/tenant-runtime/infrastructure/drizzle-tenant-database-resolver.js";
import { createPgTenantDatabaseConnectionManager } from "../modules/tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";

/**
 * Composes the media processing worker's full pipeline (Prompt 032, ADR-008) and returns a
 * handle to it — same extraction pattern as `provisioning-worker-runtime.ts`/
 * `media-outbox-dispatcher-runtime.ts` (Prompt 031): this worker also needs to resolve *tenant
 * application* credentials (to open each tenant's own Tenant Data Plane database and
 * read/write `property_media`/`property_media_variants`/`outbox_events`), so it receives its
 * `SecretStore` from the caller rather than constructing one internally — the same mechanism
 * that lets `src/main/dev-full.ts` share the *same* in-memory `SecretStore` instance the
 * provisioning worker already writes tenant secrets into, closing the same cross-process gap
 * documented for `provisioning-worker.ts` vs `server.ts` (ARCHITECTURE.md "Local development
 * runtime"). `ObjectStorage` is likewise supplied by the caller (this task, section 31) — real
 * Cloudflare R2 in `server.ts`-style entrypoints, an in-memory fake in tests — never constructed
 * here.
 *
 * Deliberately does NOT include: the `NODE_ENV=production`/R2-configuration fail-fasts (the
 * caller performs those explicitly first, same convention as every other entrypoint), `pino()`
 * construction, signal handlers, or `controlPlanePool` lifecycle.
 */
export interface MediaProcessingWorkerRuntime {
  shutdown(): Promise<void>;
}

export function createMediaProcessingWorkerRuntime(
  secretStore: SecretStore,
  objectStorage: ObjectStorage,
  logger: Logger,
): MediaProcessingWorkerRuntime {
  const tenantDatabaseResolver = createDrizzleTenantDatabaseResolver(controlPlaneDb);
  const tenantDatabaseConnectionManager = createPgTenantDatabaseConnectionManager({
    credentialResolver: createTenantDatabaseCredentialResolver(secretStore),
  });
  const imageVariantProcessor = createSharpImageVariantProcessor({
    maxInputPixels: env.MEDIA_PROCESSING_MAX_INPUT_PIXELS,
  });

  const redisConnection = createRedisConnection();
  const worker = createMediaProcessingWorker(redisConnection, {
    tenantDatabaseResolver,
    tenantDatabaseConnectionManager,
    objectStorage,
    imageVariantProcessor,
    concurrency: env.MEDIA_PROCESSING_WORKER_CONCURRENCY,
  });

  worker.on("completed", (job) => {
    logger.info(
      {
        operation: "media-processing-worker.job",
        outboxEventId: job.id,
        tenantId: job.data.tenantId,
        propertyId: job.data.propertyId,
        mediaId: job.data.mediaId,
      },
      "property media processing job completed",
    );
  });

  worker.on("failed", (job, err) => {
    logger.error(
      {
        operation: "media-processing-worker.job",
        outboxEventId: job?.id,
        tenantId: job?.data.tenantId,
        propertyId: job?.data.propertyId,
        mediaId: job?.data.mediaId,
        attemptsMade: job?.attemptsMade,
        err,
      },
      "property media processing job failed",
    );
  });

  return {
    async shutdown(): Promise<void> {
      await worker.close();
      await redisConnection.quit();
      await tenantDatabaseConnectionManager.close();
    },
  };
}
