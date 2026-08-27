import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import { provisioningJobs, tenants } from "../../../infrastructure/database/control-plane/schema.js";
import { createRedisConnection } from "../../../infrastructure/queue/redis-connection.js";
import {
  createTenantProvisioningQueue,
  PROVISION_TENANT_JOB_NAME,
  type TenantProvisioningQueue,
} from "../../../infrastructure/queue/tenant-provisioning-queue.js";
import type { DatabaseProvisioner } from "../application/process-provisioning-job.js";
import { createProvisioningWorker } from "./bullmq-provisioning-worker.js";
import { createDrizzleProcessProvisioningJobRepository } from "./drizzle-process-provisioning-job-repository.js";

const repository = createDrizzleProcessProvisioningJobRepository(controlPlaneDb);

let connection: ReturnType<typeof createRedisConnection>;
let queue: TenantProvisioningQueue;

beforeEach(async () => {
  await controlPlaneDb.execute(sql`TRUNCATE TABLE ${provisioningJobs}, ${tenants} CASCADE`);
  connection = createRedisConnection();
  queue = createTenantProvisioningQueue(connection);
});

afterEach(async () => {
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await connection.quit();
});

afterAll(async () => {
  await controlPlanePool.end();
});

async function insertTenant(slug: string) {
  const [tenant] = await controlPlaneDb
    .insert(tenants)
    .values({ slug, name: `Tenant ${slug}` })
    .returning();

  if (!tenant) {
    throw new Error("tenant insert returned no row");
  }

  return tenant;
}

async function insertJob(tenantId: string) {
  const [job] = await controlPlaneDb
    .insert(provisioningJobs)
    .values({ tenantId, type: "CREATE_DATABASE" })
    .returning();

  if (!job) {
    throw new Error("provisioning job insert returned no row");
  }

  return job;
}

// Arbitrary but internally consistent — only used to satisfy DatabaseProvisioner's return
// type; no test in this file inspects its fields.
const FAKE_PROVISIONING_RESULT = {
  clusterId: "cluster-1",
  databaseName: "tenant_fake",
  secretReference: "tenant-databases/fake",
  schemaVersion: 1,
};

function fakeProvisioner(behavior: "succeed" | "throw" = "succeed") {
  const calls: { provisioningJobId: string; tenantId: string }[] = [];

  const provisioner: DatabaseProvisioner = {
    provision: async (input) => {
      calls.push(input);
      if (behavior === "throw") {
        throw new Error("provisioning boom");
      }
      return FAKE_PROVISIONING_RESULT;
    },
  };

  return { provisioner, calls };
}

function waitForJobSettled(
  worker: ReturnType<typeof createProvisioningWorker>,
  jobId: string,
): Promise<"completed" | "failed"> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for job to settle")), 10_000);

    worker.on("completed", (job) => {
      if (job.id === jobId) {
        clearTimeout(timeout);
        resolve("completed");
      }
    });
    worker.on("failed", (job, err) => {
      if (job?.id === jobId) {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

describe("createProvisioningWorker (real Redis + PostgreSQL, fake DatabaseProvisioner)", () => {
  it("consumes a queued job and drives the provisioning job to SUCCEEDED", async () => {
    const tenant = await insertTenant("worker-success");
    const job = await insertJob(tenant.id);
    const { provisioner, calls } = fakeProvisioner("succeed");

    await queue.add(
      PROVISION_TENANT_JOB_NAME,
      { provisioningJobId: job.id, tenantId: tenant.id },
      { jobId: job.id, attempts: 1 },
    );

    const worker = createProvisioningWorker(connection, repository, provisioner);
    try {
      await waitForJobSettled(worker, job.id);
    } finally {
      await worker.close();
    }

    expect(calls).toEqual([{ provisioningJobId: job.id, tenantId: tenant.id }]);

    const [row] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.id, job.id));
    expect(row?.status).toBe("SUCCEEDED");
  });

  it("drives the provisioning job to FAILED when the provisioner throws, without failing the BullMQ job", async () => {
    const tenant = await insertTenant("worker-failure");
    const job = await insertJob(tenant.id);
    const { provisioner, calls } = fakeProvisioner("throw");

    await queue.add(
      PROVISION_TENANT_JOB_NAME,
      { provisioningJobId: job.id, tenantId: tenant.id },
      { jobId: job.id, attempts: 1 },
    );

    const worker = createProvisioningWorker(connection, repository, provisioner);
    let settled: "completed" | "failed";
    try {
      settled = await waitForJobSettled(worker, job.id);
    } finally {
      await worker.close();
    }

    expect(calls).toHaveLength(1);
    // A FAILED-but-persisted outcome is a completed BullMQ job, not a callback failure — see
    // bullmq-provisioning-worker.ts: BullMQ must not reinvent provisioning retry policy.
    expect(settled).toBe("completed");

    const [row] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.id, job.id));
    expect(row?.status).toBe("FAILED");
    expect(row?.errorMessage).toBe("provisioning boom");
  });

  it("does not call the provisioner again for a job already SUCCEEDED (idempotent redelivery)", async () => {
    const tenant = await insertTenant("worker-idempotent");
    const job = await insertJob(tenant.id);
    const { provisioner, calls } = fakeProvisioner("succeed");

    await queue.add(
      PROVISION_TENANT_JOB_NAME,
      { provisioningJobId: job.id, tenantId: tenant.id },
      { jobId: job.id, attempts: 1 },
    );

    const worker = createProvisioningWorker(connection, repository, provisioner);
    try {
      await waitForJobSettled(worker, job.id);
      expect(calls).toHaveLength(1);

      // Simulate redelivery of the same logical job (e.g. a stalled-job requeue) with a new
      // BullMQ job instance carrying the same payload. The persisted state machine — not
      // BullMQ's own jobId dedup — is what must prevent a second real provisioning attempt.
      const redelivered = await queue.add(
        PROVISION_TENANT_JOB_NAME,
        { provisioningJobId: job.id, tenantId: tenant.id },
        { attempts: 1 },
      );
      if (!redelivered.id) {
        throw new Error("expected the redelivered job to have an id");
      }
      await waitForJobSettled(worker, redelivered.id);
    } finally {
      await worker.close();
    }

    expect(calls).toHaveLength(1);

    const [row] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.id, job.id));
    expect(row?.status).toBe("SUCCEEDED");
  });
});
