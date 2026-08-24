import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import { provisioningJobs, tenants } from "../../../infrastructure/database/control-plane/schema.js";
import { PROVISION_DATABASE_STEP } from "../application/process-provisioning-job.js";
import { createDrizzleProcessProvisioningJobRepository } from "./drizzle-process-provisioning-job-repository.js";

const repository = createDrizzleProcessProvisioningJobRepository(controlPlaneDb);

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

async function fetchJob(jobId: string) {
  const [row] = await controlPlaneDb
    .select()
    .from(provisioningJobs)
    .where(eq(provisioningJobs.id, jobId));

  return row;
}

beforeEach(async () => {
  await controlPlaneDb.execute(sql`TRUNCATE TABLE ${provisioningJobs}, ${tenants} CASCADE`);
});

afterAll(async () => {
  await controlPlanePool.end();
});

describe("markRunning", () => {
  it("claims a PENDING job: sets RUNNING, increments attempts, sets startedAt/currentStep", async () => {
    const tenant = await insertTenant("claim");
    const job = await insertJob(tenant.id);

    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP);

    expect(claimed).toEqual({ id: job.id, tenantId: tenant.id, status: "RUNNING" });

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("RUNNING");
    expect(row?.attempts).toBe(1);
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row?.currentStep).toBe(PROVISION_DATABASE_STEP);
  });

  it("increments attempts from whatever it currently holds, not just 0 → 1", async () => {
    const tenant = await insertTenant("attempts");
    const job = await insertJob(tenant.id);
    await controlPlaneDb
      .update(provisioningJobs)
      .set({ attempts: 3 })
      .where(eq(provisioningJobs.id, job.id));

    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);

    const row = await fetchJob(job.id);
    expect(row?.attempts).toBe(4);
  });

  it("does not claim a job that is not PENDING", async () => {
    const tenant = await insertTenant("not-pending");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP); // now RUNNING

    const second = await repository.markRunning(job.id, PROVISION_DATABASE_STEP);

    expect(second).toBeUndefined();
  });

  it("never lets two concurrent claimers both win the PENDING → RUNNING transition", async () => {
    const tenant = await insertTenant("concurrent-claim");
    const job = await insertJob(tenant.id);

    // Two genuinely concurrent updates against the same pool — exercises the real guarded
    // UPDATE, not a mocked guarantee.
    const [first, second] = await Promise.all([
      repository.markRunning(job.id, PROVISION_DATABASE_STEP),
      repository.markRunning(job.id, PROVISION_DATABASE_STEP),
    ]);

    const winners = [first, second].filter((result) => result !== undefined);
    expect(winners).toHaveLength(1);

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("RUNNING");
    expect(row?.attempts).toBe(1);
  });
});

describe("markSucceeded", () => {
  it("transitions RUNNING → SUCCEEDED and sets finishedAt", async () => {
    const tenant = await insertTenant("succeed");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);

    await repository.markSucceeded(job.id);

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it("does not transition a job that is not RUNNING (guard)", async () => {
    const tenant = await insertTenant("guard-succeed");
    const job = await insertJob(tenant.id); // still PENDING

    await repository.markSucceeded(job.id);

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("PENDING");
    expect(row?.finishedAt).toBeNull();
  });
});

describe("markFailed", () => {
  it("transitions RUNNING → FAILED, sets finishedAt and errorMessage", async () => {
    const tenant = await insertTenant("fail");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);

    await repository.markFailed(job.id, "provisioning boom");

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("FAILED");
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(row?.errorMessage).toBe("provisioning boom");
  });

  it("does not transition a job that is not RUNNING (guard)", async () => {
    const tenant = await insertTenant("guard-fail");
    const job = await insertJob(tenant.id); // still PENDING

    await repository.markFailed(job.id, "should not apply");

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("PENDING");
    expect(row?.errorMessage).toBeNull();
  });

  it("cannot flip an already-SUCCEEDED job to FAILED (guard)", async () => {
    const tenant = await insertTenant("succeeded-then-fail");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);
    await repository.markSucceeded(job.id);

    await repository.markFailed(job.id, "should not apply");

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.errorMessage).toBeNull();
  });
});

describe("findById", () => {
  it("returns undefined for a non-existent job", async () => {
    const result = await repository.findById("00000000-0000-0000-0000-000000000000");

    expect(result).toBeUndefined();
  });
});
