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

/**
 * No consumer is created here (this task, section 44) — only the queue/job contract a future
 * dispatcher (not implemented yet, see ADR-008 "Deferred dispatcher design") will publish to,
 * and a future worker (not implemented yet) will consume from.
 */
export function createMediaProcessingQueue(connection: Redis): MediaProcessingQueue {
  return new Queue<ProcessPropertyMediaJobPayload>(MEDIA_PROCESSING_QUEUE_NAME, { connection });
}
