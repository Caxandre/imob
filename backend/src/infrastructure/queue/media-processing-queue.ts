import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";

/**
 * Distinct from `tenant-provisioning` (this task, section 34) — image processing is a
 * different, CPU-bound workload with its own retry/concurrency needs (ADR-008 "Operational
 * consequences"), never sharing a queue with provisioning.
 */
export const MEDIA_PROCESSING_QUEUE_NAME = "media-processing";
export const PROCESS_PROPERTY_MEDIA_JOB_NAME = "process-property-media";

/**
 * Minimal payload by design (ADR-008 "Queue and worker", this task, section 36/37) — the worker
 * always resolves the Tenant Data Plane from `tenantId` and re-fetches the original from
 * `ObjectStorage` by the `object_key` already persisted; nothing here is a shortcut around that.
 * Never: R2/database credentials, the public URL, or raw image bytes.
 */
export const processPropertyMediaJobPayloadSchema = z
  .object({
    tenantId: z.uuid(),
    propertyId: z.uuid(),
    mediaId: z.uuid(),
  })
  .strict();

export type ProcessPropertyMediaJobPayload = z.infer<typeof processPropertyMediaJobPayloadSchema>;

export type MediaProcessingQueue = Queue<ProcessPropertyMediaJobPayload>;

export interface CreateMediaProcessingQueueOptions {
  /** Retry policy for every job added to this queue (ADR-008 "Failure handling", Prompt 032,
   * section 35/36) — configured once here, at the queue level, never invented later by the
   * worker after a job already exists. Unlike the provisioning queue's explicit `attempts: 1`
   * (ADR-002 — that workflow delegates all recovery to its own execution-lease mechanism, never
   * to BullMQ), image processing is a different workload that does want BullMQ to retry
   * transient failures automatically. */
  attempts: number;
  /** Base delay (ms) for BullMQ's exponential backoff — attempt N waits roughly
   * `backoffDelayMs * 2^(N-1)`. */
  backoffDelayMs: number;
}

export function createMediaProcessingQueue(
  connection: Redis,
  options: CreateMediaProcessingQueueOptions,
): MediaProcessingQueue {
  return new Queue<ProcessPropertyMediaJobPayload>(MEDIA_PROCESSING_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: options.attempts,
      backoff: { type: "exponential", delay: options.backoffDelayMs },
    },
  });
}
