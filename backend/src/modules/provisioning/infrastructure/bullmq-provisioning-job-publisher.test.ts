import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createRedisConnection } from "../../../infrastructure/queue/redis-connection.js";
import {
  createTenantProvisioningQueue,
  type TenantProvisioningQueue,
} from "../../../infrastructure/queue/tenant-provisioning-queue.js";
import { createBullMqProvisioningJobPublisher } from "./bullmq-provisioning-job-publisher.js";

let connection: ReturnType<typeof createRedisConnection>;
let queue: TenantProvisioningQueue;

beforeAll(() => {
  connection = createRedisConnection();
  queue = createTenantProvisioningQueue(connection);
});

afterEach(async () => {
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.close();
  await connection.quit();
});

describe("createBullMqProvisioningJobPublisher (real Redis/BullMQ)", () => {
  it("creates a BullMQ job with id = provisioning_job.id and a minimal payload", async () => {
    const publisher = createBullMqProvisioningJobPublisher(queue);
    const provisioningJobId = randomUUID();
    const tenantId = randomUUID();

    await publisher.publish({ id: provisioningJobId, tenantId });

    const job = await queue.getJob(provisioningJobId);

    expect(job).toBeDefined();
    expect(job?.id).toBe(provisioningJobId);
    expect(job?.name).toBe("provision-tenant");
    // Minimal payload only — no credentials, no tenant business data.
    expect(job?.data).toEqual({ provisioningJobId, tenantId });
  });

  it("does not create a second logical job when the same jobId is published twice", async () => {
    const publisher = createBullMqProvisioningJobPublisher(queue);
    const provisioningJobId = randomUUID();
    const tenantId = randomUUID();

    await publisher.publish({ id: provisioningJobId, tenantId });
    await publisher.publish({ id: provisioningJobId, tenantId });

    const counts = await queue.getJobCounts();
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    // Observed behavior of bullmq@6: re-adding an existing, not-yet-removed jobId resolves
    // to the same underlying job instead of creating a second one — exactly the guarantee
    // ADR-002 relies on for safe redelivery after a crash or lease expiry.
    expect(total).toBe(1);

    const job = await queue.getJob(provisioningJobId);
    expect(job?.id).toBe(provisioningJobId);
  });
});
