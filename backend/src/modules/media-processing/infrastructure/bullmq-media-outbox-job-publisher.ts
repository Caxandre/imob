import {
  PROCESS_PROPERTY_MEDIA_JOB_NAME,
  processPropertyMediaJobPayloadSchema,
  type MediaProcessingQueue,
} from "../../../infrastructure/queue/media-processing-queue.js";
import type { DispatchMediaOutboxJob, MediaOutboxJobPublisher } from "../application/dispatch-media-outbox-events.js";

export function createBullMqMediaOutboxJobPublisher(queue: MediaProcessingQueue): MediaOutboxJobPublisher {
  return {
    async publish(job: DispatchMediaOutboxJob): Promise<void> {
      // Validated one more time at this exact boundary (this task, section 24/67) — the wire
      // contract for what actually reaches BullMQ is always enforced here, independent of how
      // confident the caller already is that tenantId/propertyId/mediaId are well-formed.
      const payload = processPropertyMediaJobPayloadSchema.parse({
        tenantId: job.tenantId,
        propertyId: job.propertyId,
        mediaId: job.mediaId,
      });

      // jobId = outbox_events.id (this task, section 16/17) — the exact identifier of the
      // persisted intent this job represents, never a fresh UUID per attempt. If the
      // dispatcher crashes after this call resolves but before markDispatched() commits, the
      // next cycle re-claims the same outbox event and calls publish() again with the SAME
      // jobId — BullMQ resolves that to the existing job (or treats it as a no-op if that job
      // already completed and was removed) instead of creating a second logical unit of work.
      // A crash in that narrow window can at most cause a redundant confirmation attempt,
      // never a duplicate processing job.
      //
      // `attempts`/backoff are deliberately left unset here — that policy belongs to the
      // future worker implementation (ADR-008 "Failure handling": transient errors should be
      // retried with exponential backoff, values not invented ahead of that worker existing).
      // BullMQ's own default (no automatic retry) applies until that decision is made
      // explicitly, matching this task's instruction not to invent arbitrary values.
      await queue.add(PROCESS_PROPERTY_MEDIA_JOB_NAME, payload, { jobId: job.outboxEventId });
    },
  };
}
