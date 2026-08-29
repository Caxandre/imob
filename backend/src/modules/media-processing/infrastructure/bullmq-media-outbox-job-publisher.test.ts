import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMediaProcessingQueue,
  PROCESS_PROPERTY_MEDIA_JOB_NAME,
  type MediaProcessingQueue,
} from "../../../infrastructure/queue/media-processing-queue.js";
import { createRedisConnection } from "../../../infrastructure/queue/redis-connection.js";
import type { DispatchMediaOutboxJob } from "../application/dispatch-media-outbox-events.js";
import { createBullMqMediaOutboxJobPublisher } from "./bullmq-media-outbox-job-publisher.js";

/** Real Redis (Docker Compose), never mocked — jobId/idempotency behavior is exactly what
 * this suite needs to prove, and that behavior belongs to the real BullMQ/Redis integration,
 * never something a mock could stand in for (this task, section 63). */
let connection: ReturnType<typeof createRedisConnection>;
let queue: MediaProcessingQueue;

beforeEach(() => {
  connection = createRedisConnection();
  queue = createMediaProcessingQueue(connection, { attempts: 5, backoffDelayMs: 5000 });
});

afterEach(async () => {
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await connection.quit();
});

function sampleJob(overrides: Partial<DispatchMediaOutboxJob> = {}): DispatchMediaOutboxJob {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    outboxEventId: "22222222-2222-4222-8222-222222222222",
    propertyId: "33333333-3333-4333-8333-333333333333",
    mediaId: "44444444-4444-4444-8444-444444444444",
    ...overrides,
  };
}

describe("createBullMqMediaOutboxJobPublisher (real Redis)", () => {
  it("adds a job with the documented name, jobId = outboxEventId, and the minimal payload", async () => {
    const publisher = createBullMqMediaOutboxJobPublisher(queue);
    const job = sampleJob();

    await publisher.publish(job);

    const found = await queue.getJob(job.outboxEventId);
    expect(found).toBeDefined();
    expect(found?.name).toBe(PROCESS_PROPERTY_MEDIA_JOB_NAME);
    expect(found?.id).toBe(job.outboxEventId);
    expect(found?.data).toEqual({
      tenantId: job.tenantId,
      propertyId: job.propertyId,
      mediaId: job.mediaId,
    });
  });

  it("never includes credentials, public URLs, or raw bytes in the job payload", async () => {
    const publisher = createBullMqMediaOutboxJobPublisher(queue);
    const job = sampleJob();

    await publisher.publish(job);

    const found = await queue.getJob(job.outboxEventId);
    expect(Object.keys(found?.data ?? {}).sort()).toEqual(["mediaId", "propertyId", "tenantId"]);
  });

  it("publishing the same outboxEventId twice resolves to the same underlying job — never a duplicate", async () => {
    const publisher = createBullMqMediaOutboxJobPublisher(queue);
    const job = sampleJob();

    await publisher.publish(job);
    // Simulates the dispatcher crashing after queue.add() resolved but before markDispatched()
    // committed (this task, section 17/59) — the next cycle re-claims the same outbox event
    // and calls publish() again with the identical jobId.
    await publisher.publish(job);

    const counts = await queue.getJobCounts();
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(1);
  });

  it("rejects a malformed job at the publish boundary instead of ever calling queue.add with bad data", async () => {
    const publisher = createBullMqMediaOutboxJobPublisher(queue);

    await expect(publisher.publish(sampleJob({ mediaId: "not-a-uuid" }))).rejects.toThrow();

    const found = await queue.getJob("22222222-2222-4222-8222-222222222222");
    expect(found).toBeUndefined();
  });
});
