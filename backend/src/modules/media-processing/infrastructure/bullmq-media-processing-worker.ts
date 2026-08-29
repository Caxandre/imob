import { UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";

import {
  MEDIA_PROCESSING_QUEUE_NAME,
  PROCESS_PROPERTY_MEDIA_JOB_NAME,
  processPropertyMediaJobPayloadSchema,
  type ProcessPropertyMediaJobPayload,
} from "../../../infrastructure/queue/media-processing-queue.js";
import type { ObjectStorage } from "../../../infrastructure/object-storage/object-storage.js";
import { buildPropertyMediaVariantObjectKey } from "../../properties/domain/property-media-variant.js";
import type { TenantDatabaseConnectionManager } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { TenantDatabaseResolver } from "../../tenant-runtime/application/tenant-database-resolver.js";
import type { ImageVariantProcessor } from "../application/image-variant-processor.js";
import { processPropertyMediaJob } from "../application/process-property-media-job.js";
import { createDrizzlePropertyMediaProcessingRepository } from "./drizzle-property-media-processing-repository.js";

export interface MediaProcessingWorkerDependencies {
  tenantDatabaseResolver: TenantDatabaseResolver;
  tenantDatabaseConnectionManager: TenantDatabaseConnectionManager;
  objectStorage: ObjectStorage;
  imageVariantProcessor: ImageVariantProcessor;
  concurrency: number;
}

async function runProcessing(
  deps: MediaProcessingWorkerDependencies,
  outboxEventId: string,
  payload: ProcessPropertyMediaJobPayload,
) {
  const target = await deps.tenantDatabaseResolver.resolve(payload.tenantId);
  return deps.tenantDatabaseConnectionManager.withTenantDatabase(target, (db) => {
    const repository = createDrizzlePropertyMediaProcessingRepository(db);
    return processPropertyMediaJob(
      {
        repository,
        objectStorage: deps.objectStorage,
        imageVariantProcessor: deps.imageVariantProcessor,
        buildVariantObjectKey: buildPropertyMediaVariantObjectKey,
      },
      { outboxEventId, tenantId: payload.tenantId, propertyId: payload.propertyId, mediaId: payload.mediaId },
    );
  });
}

/**
 * Real, BullMQ-backed consumer of the `media-processing` queue (Prompt 032, ADR-008). All the
 * BullMQ-specific decisions live here, never in `processPropertyMediaJob` (pure orchestration):
 *
 * - `job.id` is always the outbox event id (ADR-009: the dispatcher publishes with
 *   `jobId = outbox_events.id`) — validated as a UUID before use (this task, section 27),
 *   never derived by searching for "the latest outbox event" for the media.
 * - `job.data` is re-validated against the same Zod schema the dispatcher used (section 28) —
 *   never trusted just because the dispatcher already validated it once.
 * - A `{ outcome: "failed-permanent" }` result (domain already persisted FAILED +
 *   `processed_at`) is turned into a BullMQ `UnrecoverableError` (section 56) — no further
 *   automatic retry can ever help a permanently-classified original.
 * - Any other thrown error (transient — R2 unreachable, PostgreSQL blip, ...) is left alone on
 *   an attempt that still has retries left, so BullMQ's own configured backoff applies
 *   (section 57). On the *last* configured attempt, this worker makes one best-effort attempt
 *   to persist a terminal `FAILED` itself (section 58) before letting the original error
 *   propagate as this attempt's failure — if that finalize also fails, the original error still
 *   propagates unchanged (section 59: never fake success).
 */
export function createMediaProcessingWorker(
  connection: Redis,
  deps: MediaProcessingWorkerDependencies,
): Worker<ProcessPropertyMediaJobPayload> {
  return new Worker<ProcessPropertyMediaJobPayload>(
    MEDIA_PROCESSING_QUEUE_NAME,
    async (job: Job<ProcessPropertyMediaJobPayload>) => {
      if (job.name !== PROCESS_PROPERTY_MEDIA_JOB_NAME) {
        throw new Error(`Unexpected job name "${job.name}" on queue "${MEDIA_PROCESSING_QUEUE_NAME}"`);
      }

      const outboxEventId = z.uuid().parse(job.id);
      const payload = processPropertyMediaJobPayloadSchema.parse(job.data);

      try {
        const outcome = await runProcessing(deps, outboxEventId, payload);
        if (outcome.outcome === "failed-permanent") {
          throw new UnrecoverableError("property media processing failed permanently");
        }
        return;
      } catch (error) {
        if (error instanceof UnrecoverableError) {
          throw error;
        }

        const attemptsMade = job.attemptsMade + 1;
        const maxAttempts = job.opts.attempts ?? 1;
        if (attemptsMade < maxAttempts) {
          throw error; // Attempts remain — let BullMQ retry with its configured backoff.
        }

        // Last attempt exhausted (section 58) — try to persist a terminal FAILED so the media
        // never stays stuck in PROCESSING forever just because R2/PostgreSQL kept being
        // transiently unavailable.
        try {
          const target = await deps.tenantDatabaseResolver.resolve(payload.tenantId);
          await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, (db) => {
            const repository = createDrizzlePropertyMediaProcessingRepository(db);
            return repository.finalizeFailed({ outboxEventId, mediaId: payload.mediaId });
          });
        } catch {
          // Section 59 — never fake success here. The *original* error (caught above) still
          // propagates below, ending this job as a normal BullMQ failure either way. Manual
          // requeue/recovery for this operational edge case is out of scope for this task.
        }

        throw error;
      }
    },
    { connection, concurrency: deps.concurrency },
  );
}
