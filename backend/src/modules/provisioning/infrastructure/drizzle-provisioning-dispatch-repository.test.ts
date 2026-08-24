import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import {
  provisioningJobs,
  tenants,
  type provisioningJobStatus,
} from "../../../infrastructure/database/control-plane/schema.js";
import { createDrizzleProvisioningDispatchRepository } from "./drizzle-provisioning-dispatch-repository.js";

type ProvisioningJobStatus = (typeof provisioningJobStatus.enumValues)[number];

const repository = createDrizzleProvisioningDispatchRepository(controlPlaneDb);
const DEFAULT_CLAIM_INPUT = { batchSize: 10, leaseSeconds: 30 };

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

interface InsertJobOverrides {
  status?: ProvisioningJobStatus;
  dispatchedAt?: Date;
  dispatchClaimedAt?: Date;
  dispatchLeaseUntil?: Date;
}

async function insertJob(tenantId: string, overrides: InsertJobOverrides = {}) {
  const [job] = await controlPlaneDb
    .insert(provisioningJobs)
    .values({
      tenantId,
      type: "CREATE_DATABASE",
      status: overrides.status ?? "PENDING",
      dispatchedAt: overrides.dispatchedAt,
      dispatchClaimedAt: overrides.dispatchClaimedAt,
      dispatchLeaseUntil: overrides.dispatchLeaseUntil,
    })
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

describe("claimEligibleJobs", () => {
  it("claims an eligible job and sets claim/lease timestamps using PostgreSQL's clock", async () => {
    const tenant = await insertTenant("eligible");
    const job = await insertJob(tenant.id);

    const claimed = await repository.claimEligibleJobs(DEFAULT_CLAIM_INPUT);

    expect(claimed).toEqual([{ id: job.id, tenantId: tenant.id }]);

    const row = await fetchJob(job.id);
    expect(row?.dispatchClaimedAt).toBeInstanceOf(Date);
    expect(row?.dispatchLeaseUntil).toBeInstanceOf(Date);
    expect(row!.dispatchLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not claim a job that already has a valid lease", async () => {
    const tenant = await insertTenant("leased");
    const now = new Date();
    await insertJob(tenant.id, {
      dispatchClaimedAt: now,
      dispatchLeaseUntil: new Date(now.getTime() + 3_600_000),
    });

    const claimed = await repository.claimEligibleJobs(DEFAULT_CLAIM_INPUT);

    expect(claimed).toEqual([]);
  });

  it("recovers a job whose lease has expired", async () => {
    const tenant = await insertTenant("expired-lease");
    const past = new Date(Date.now() - 3_600_000);
    const job = await insertJob(tenant.id, { dispatchClaimedAt: past, dispatchLeaseUntil: past });

    const claimed = await repository.claimEligibleJobs(DEFAULT_CLAIM_INPUT);

    expect(claimed).toEqual([{ id: job.id, tenantId: tenant.id }]);
  });

  it("does not claim a job that is already dispatched", async () => {
    const tenant = await insertTenant("already-dispatched");
    await insertJob(tenant.id, { dispatchedAt: new Date() });

    const claimed = await repository.claimEligibleJobs(DEFAULT_CLAIM_INPUT);

    expect(claimed).toEqual([]);
  });

  it("does not claim a job that is not PENDING", async () => {
    const tenant = await insertTenant("running");
    await insertJob(tenant.id, { status: "RUNNING" });

    const claimed = await repository.claimEligibleJobs(DEFAULT_CLAIM_INPUT);

    expect(claimed).toEqual([]);
  });

  it("respects the batch size limit", async () => {
    const tenant = await insertTenant("batch");
    for (let i = 0; i < 5; i++) {
      await insertJob(tenant.id);
    }

    const claimed = await repository.claimEligibleJobs({ batchSize: 2, leaseSeconds: 30 });

    expect(claimed).toHaveLength(2);
  });
});

describe("claimEligibleJobs — concurrency (real PostgreSQL)", () => {
  it("never lets two concurrent claimers select the same job", async () => {
    const tenant = await insertTenant("concurrent");
    const inserted = [];
    for (let i = 0; i < 10; i++) {
      inserted.push(await insertJob(tenant.id));
    }

    // Two genuinely concurrent transactions against the same pool — this exercises real
    // FOR UPDATE SKIP LOCKED, not a mocked guarantee.
    const [resultA, resultB] = await Promise.all([
      repository.claimEligibleJobs(DEFAULT_CLAIM_INPUT),
      repository.claimEligibleJobs(DEFAULT_CLAIM_INPUT),
    ]);

    const idsA = new Set(resultA.map((job) => job.id));
    const idsB = new Set(resultB.map((job) => job.id));
    const intersection = [...idsA].filter((id) => idsB.has(id));

    expect(intersection).toEqual([]);
    // Together, the two claimers must have covered every eligible job exactly once.
    expect(idsA.size + idsB.size).toBe(inserted.length);
  });
});

describe("markDispatched", () => {
  it("sets dispatchedAt and clears the lease, keeping the claim timestamp", async () => {
    const tenant = await insertTenant("to-dispatch");
    const now = new Date();
    const job = await insertJob(tenant.id, {
      dispatchClaimedAt: now,
      dispatchLeaseUntil: new Date(now.getTime() + 30_000),
    });

    await repository.markDispatched(job.id);

    const row = await fetchJob(job.id);
    expect(row?.dispatchedAt).toBeInstanceOf(Date);
    expect(row?.dispatchLeaseUntil).toBeNull();
    expect(row?.dispatchClaimedAt).toBeInstanceOf(Date);
  });

  it("does not overwrite an already-confirmed dispatchedAt", async () => {
    const tenant = await insertTenant("already-confirmed");
    const originalDispatchedAt = new Date("2020-01-01T00:00:00.000Z");
    const job = await insertJob(tenant.id, { dispatchedAt: originalDispatchedAt });

    await repository.markDispatched(job.id);

    const row = await fetchJob(job.id);
    expect(row?.dispatchedAt?.toISOString()).toBe(originalDispatchedAt.toISOString());
  });
});

describe("releaseLease", () => {
  it("clears the lease while keeping the claim timestamp for observability", async () => {
    const tenant = await insertTenant("release-me");
    const now = new Date();
    const job = await insertJob(tenant.id, {
      dispatchClaimedAt: now,
      dispatchLeaseUntil: new Date(now.getTime() + 30_000),
    });

    await repository.releaseLease(job.id);

    const row = await fetchJob(job.id);
    expect(row?.dispatchLeaseUntil).toBeNull();
    expect(row?.dispatchClaimedAt).toBeInstanceOf(Date);
    expect(row?.dispatchedAt).toBeNull();
  });
});
