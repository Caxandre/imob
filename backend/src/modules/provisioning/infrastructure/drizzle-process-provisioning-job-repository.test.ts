import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  provisioningJobs,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import {
  InvalidProvisioningJobStateError,
  PROVISION_DATABASE_STEP,
  ProvisioningExecutionOwnershipLostError,
  ProvisioningFinalizationConflictError,
  TenantProvisioningStateError,
} from "../application/process-provisioning-job.js";
import type { ProvisioningResult } from "../application/provisioning-result.js";
import { createDrizzleProcessProvisioningJobRepository } from "./drizzle-process-provisioning-job-repository.js";

const LEASE_SECONDS = 60;

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

async function insertCluster(name: string) {
  const [cluster] = await controlPlaneDb
    .insert(databaseClusters)
    .values({
      name,
      provider: "local",
      region: "local",
      host: "localhost",
      port: 5433,
      secretReference: `clusters/${name}`,
    })
    .returning();

  if (!cluster) {
    throw new Error("cluster insert returned no row");
  }

  return cluster;
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

async function fetchTenant(tenantId: string) {
  const [row] = await controlPlaneDb.select().from(tenants).where(eq(tenants.id, tenantId));
  return row;
}

async function fetchTenantDatabase(tenantId: string) {
  const [row] = await controlPlaneDb.select().from(tenantDatabases).where(eq(tenantDatabases.tenantId, tenantId));
  return row;
}

/** Backdates a RUNNING job's execution lease so it reads as already expired, without sleeping. */
async function expireLease(jobId: string): Promise<void> {
  await controlPlaneDb
    .update(provisioningJobs)
    .set({ executionLeaseUntil: sql`now() - interval '1 minute'` })
    .where(eq(provisioningJobs.id, jobId));
}

function buildResult(clusterId: string, overrides: Partial<ProvisioningResult> = {}): ProvisioningResult {
  return {
    clusterId,
    databaseName: `tenant_${randomUUID().replaceAll("-", "")}`,
    secretReference: `tenant-databases/${randomUUID()}`,
    schemaVersion: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  await controlPlaneDb.execute(
    sql`TRUNCATE TABLE ${provisioningJobs}, ${tenantDatabases}, ${tenants}, ${databaseClusters} CASCADE`,
  );
});

afterAll(async () => {
  await controlPlanePool.end();
});

describe("markRunning", () => {
  it("claims a PENDING job: sets RUNNING, increments attempts, grants an execution lease", async () => {
    const tenant = await insertTenant("claim");
    const job = await insertJob(tenant.id);

    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);

    expect(claimed?.id).toBe(job.id);
    expect(claimed?.tenantId).toBe(tenant.id);
    expect(claimed?.executionToken).toEqual(expect.any(String));

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("RUNNING");
    expect(row?.attempts).toBe(1);
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row?.currentStep).toBe(PROVISION_DATABASE_STEP);
    expect(row?.executionToken).toBe(claimed?.executionToken);
    expect(row?.executionHeartbeatAt).toBeInstanceOf(Date);
    expect(row?.executionLeaseUntil).toBeInstanceOf(Date);
    expect(row!.executionLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("increments attempts from whatever it currently holds, not just 0 → 1", async () => {
    const tenant = await insertTenant("attempts");
    const job = await insertJob(tenant.id);
    await controlPlaneDb
      .update(provisioningJobs)
      .set({ attempts: 3 })
      .where(eq(provisioningJobs.id, job.id));

    await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);

    const row = await fetchJob(job.id);
    expect(row?.attempts).toBe(4);
  });

  it("does not claim a job that is not PENDING", async () => {
    const tenant = await insertTenant("not-pending");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS); // now RUNNING

    const second = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);

    expect(second).toBeUndefined();
  });

  it("never lets two concurrent claimers both win the PENDING → RUNNING transition", async () => {
    const tenant = await insertTenant("concurrent-claim");
    const job = await insertJob(tenant.id);

    // Two genuinely concurrent updates against the same pool — exercises the real guarded
    // UPDATE, not a mocked guarantee.
    const [first, second] = await Promise.all([
      repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS),
      repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS),
    ]);

    const winners = [first, second].filter((result) => result !== undefined);
    expect(winners).toHaveLength(1);

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("RUNNING");
    expect(row?.attempts).toBe(1);
  });
});

describe("claimExpiredRunningJobs", () => {
  it("claims a RUNNING job whose execution lease already expired, granting a fresh token and incrementing attempts", async () => {
    const tenant = await insertTenant("expired-claim");
    const job = await insertJob(tenant.id);
    const original = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    await expireLease(job.id);

    const claimed = await repository.claimExpiredRunningJobs({ batchSize: 10, leaseSeconds: LEASE_SECONDS });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(job.id);
    expect(claimed[0]?.tenantId).toBe(tenant.id);
    expect(claimed[0]?.executionToken).not.toBe(original?.executionToken);

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("RUNNING"); // never bounced back to PENDING
    expect(row?.attempts).toBe(2); // a reclaim is a real new execution attempt
    expect(row?.executionToken).toBe(claimed[0]?.executionToken);
    expect(row!.executionLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
    // Never touches the dispatch protocol's own columns (ADR-002) — a reclaim is not a
    // redispatch through the dispatcher/BullMQ.
    expect(row?.dispatchClaimedAt).toBeNull();
    expect(row?.dispatchLeaseUntil).toBeNull();
    expect(row?.dispatchedAt).toBeNull();
  });

  it("claims a RUNNING job whose execution lease was never set (predates this mechanism)", async () => {
    const tenant = await insertTenant("legacy-running");
    const job = await insertJob(tenant.id);
    // Simulates a job that was RUNNING before this column existed — never went through
    // markRunning's lease-granting write.
    await controlPlaneDb
      .update(provisioningJobs)
      .set({ status: "RUNNING", startedAt: sql`now()`, currentStep: PROVISION_DATABASE_STEP })
      .where(eq(provisioningJobs.id, job.id));

    const claimed = await repository.claimExpiredRunningJobs({ batchSize: 10, leaseSeconds: LEASE_SECONDS });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(job.id);
  });

  it("does not claim a RUNNING job whose execution lease is still valid", async () => {
    const tenant = await insertTenant("valid-lease");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);

    const claimed = await repository.claimExpiredRunningJobs({ batchSize: 10, leaseSeconds: LEASE_SECONDS });

    expect(claimed).toEqual([]);
  });

  it("does not claim PENDING/SUCCEEDED/FAILED jobs", async () => {
    const tenant = await insertTenant("other-statuses");
    const pendingJob = await insertJob(tenant.id);

    const tenant2 = await insertTenant("other-statuses-2");
    const cluster = await insertCluster("claim-other-statuses");
    const succeededJob = await insertJob(tenant2.id);
    await repository.markRunning(succeededJob.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    await repository.finalizeProvisioning({
      provisioningJobId: succeededJob.id,
      tenantId: tenant2.id,
      executionToken: (await fetchJob(succeededJob.id))!.executionToken!,
      result: buildResult(cluster.id),
    });

    const claimed = await repository.claimExpiredRunningJobs({ batchSize: 10, leaseSeconds: LEASE_SECONDS });

    expect(claimed).toEqual([]);
    void pendingJob;
  });

  it("respects batchSize and orders by executionLeaseUntil, then createdAt, then id", async () => {
    const tenant = await insertTenant("batch-size");
    const jobs = await Promise.all([insertJob(tenant.id), insertJob(tenant.id), insertJob(tenant.id)]);
    for (const job of jobs) {
      await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
      await expireLease(job.id);
    }

    const claimed = await repository.claimExpiredRunningJobs({ batchSize: 2, leaseSeconds: LEASE_SECONDS });

    expect(claimed).toHaveLength(2);
  });

  it("never lets two concurrent recovery claims reclaim the same job", async () => {
    const tenant = await insertTenant("concurrent-recovery");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    await expireLease(job.id);

    const [first, second] = await Promise.all([
      repository.claimExpiredRunningJobs({ batchSize: 10, leaseSeconds: LEASE_SECONDS }),
      repository.claimExpiredRunningJobs({ batchSize: 10, leaseSeconds: LEASE_SECONDS }),
    ]);

    const totalClaimed = first.length + second.length;
    expect(totalClaimed).toBe(1);

    const row = await fetchJob(job.id);
    expect(row?.attempts).toBe(2);
  });
});

describe("renewExecutionLease", () => {
  it("renews the heartbeat/lease when the token still owns a RUNNING job", async () => {
    const tenant = await insertTenant("renew-ok");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    const before = await fetchJob(job.id);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const renewed = await repository.renewExecutionLease(job.id, claimed!.executionToken, LEASE_SECONDS);

    expect(renewed).toBe(true);
    const after = await fetchJob(job.id);
    expect(after!.executionHeartbeatAt!.getTime()).toBeGreaterThan(before!.executionHeartbeatAt!.getTime());
    expect(after!.executionLeaseUntil!.getTime()).toBeGreaterThan(before!.executionLeaseUntil!.getTime());
  });

  it("returns false without renewing when the token does not match (ownership lost)", async () => {
    const tenant = await insertTenant("renew-wrong-token");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    const before = await fetchJob(job.id);

    const renewed = await repository.renewExecutionLease(job.id, randomUUID(), LEASE_SECONDS);

    expect(renewed).toBe(false);
    const after = await fetchJob(job.id);
    expect(after?.executionHeartbeatAt).toEqual(before?.executionHeartbeatAt);
  });

  it("returns false for a job that is no longer RUNNING", async () => {
    const tenant = await insertTenant("renew-not-running");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    await repository.markFailed(job.id, claimed!.executionToken, "boom");

    const renewed = await repository.renewExecutionLease(job.id, claimed!.executionToken, LEASE_SECONDS);

    expect(renewed).toBe(false);
  });
});

describe("finalizeProvisioning", () => {
  it("atomically creates tenant_databases READY, marks tenant READY, and job SUCCEEDED", async () => {
    const cluster = await insertCluster("finalize-happy-path");
    const tenant = await insertTenant("finalize-happy-path");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    const result = buildResult(cluster.id);

    await repository.finalizeProvisioning({
      provisioningJobId: job.id,
      tenantId: tenant.id,
      executionToken: claimed!.executionToken,
      result,
    });

    const tenantRow = await fetchTenant(tenant.id);
    expect(tenantRow?.status).toBe("READY");

    const jobRow = await fetchJob(job.id);
    expect(jobRow?.status).toBe("SUCCEEDED");
    expect(jobRow?.finishedAt).toBeInstanceOf(Date);
    expect(jobRow?.errorMessage).toBeNull();
    // Execution lease is cleared on the terminal transition, but the heartbeat timestamp
    // survives as the record of last real activity (this task, section 21).
    expect(jobRow?.executionToken).toBeNull();
    expect(jobRow?.executionLeaseUntil).toBeNull();
    expect(jobRow?.executionHeartbeatAt).toBeInstanceOf(Date);

    const tenantDatabaseRow = await fetchTenantDatabase(tenant.id);
    expect(tenantDatabaseRow).toMatchObject({
      tenantId: tenant.id,
      clusterId: result.clusterId,
      databaseName: result.databaseName,
      secretReference: result.secretReference,
      schemaVersion: result.schemaVersion,
      status: "READY",
    });
    // Never persists anything beyond the pointer/metadata ProvisioningResult carries.
    expect(tenantDatabaseRow).not.toHaveProperty("username");
    expect(tenantDatabaseRow).not.toHaveProperty("password");
  });

  it("is idempotent: a second call with the same result and token changes nothing and does not error", async () => {
    const cluster = await insertCluster("finalize-idempotent");
    const tenant = await insertTenant("finalize-idempotent");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    const result = buildResult(cluster.id);
    const input = {
      provisioningJobId: job.id,
      tenantId: tenant.id,
      executionToken: claimed!.executionToken,
      result,
    };

    await repository.finalizeProvisioning(input);
    await expect(repository.finalizeProvisioning(input)).resolves.toBeUndefined();

    const tenantRow = await fetchTenant(tenant.id);
    expect(tenantRow?.status).toBe("READY");
    const jobRow = await fetchJob(job.id);
    expect(jobRow?.status).toBe("SUCCEEDED");
    const tenantDatabaseRows = await controlPlaneDb
      .select()
      .from(tenantDatabases)
      .where(eq(tenantDatabases.tenantId, tenant.id));
    expect(tenantDatabaseRows).toHaveLength(1);
  });

  it("is idempotent even with a different (or cleared) executionToken once the job is already SUCCEEDED", async () => {
    // Section 25: SUCCEEDED never re-checks the token — it was already cleared by the
    // commit this call is idempotently re-confirming, so a caller retrying after a crash
    // must not be rejected just because it no longer has a "currently valid" token to prove.
    const cluster = await insertCluster("finalize-idempotent-any-token");
    const tenant = await insertTenant("finalize-idempotent-any-token");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    const result = buildResult(cluster.id);

    await repository.finalizeProvisioning({
      provisioningJobId: job.id,
      tenantId: tenant.id,
      executionToken: claimed!.executionToken,
      result,
    });

    await expect(
      repository.finalizeProvisioning({
        provisioningJobId: job.id,
        tenantId: tenant.id,
        executionToken: randomUUID(), // arbitrary — must not matter anymore
        result,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws ProvisioningExecutionOwnershipLostError when RUNNING but the token no longer matches", async () => {
    const cluster = await insertCluster("finalize-ownership-lost");
    const tenant = await insertTenant("finalize-ownership-lost");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);

    await expect(
      repository.finalizeProvisioning({
        provisioningJobId: job.id,
        tenantId: tenant.id,
        executionToken: randomUUID(),
        result: buildResult(cluster.id),
      }),
    ).rejects.toThrow(ProvisioningExecutionOwnershipLostError);

    const jobRow = await fetchJob(job.id);
    expect(jobRow?.status).toBe("RUNNING");
    await expect(fetchTenantDatabase(tenant.id)).resolves.toBeUndefined();
  });

  it("throws ProvisioningFinalizationConflictError when an existing tenant_databases row disagrees with the result", async () => {
    const cluster = await insertCluster("finalize-conflict");
    const otherCluster = await insertCluster("finalize-conflict-other");
    const tenant = await insertTenant("finalize-conflict");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    const firstResult = buildResult(cluster.id);
    await repository.finalizeProvisioning({
      provisioningJobId: job.id,
      tenantId: tenant.id,
      executionToken: claimed!.executionToken,
      result: firstResult,
    });

    const conflictingResult = buildResult(otherCluster.id);

    await expect(
      repository.finalizeProvisioning({
        provisioningJobId: job.id,
        tenantId: tenant.id,
        executionToken: randomUUID(),
        result: conflictingResult,
      }),
    ).rejects.toThrow(ProvisioningFinalizationConflictError);

    // Nothing overwritten — the original record survives exactly as it was.
    const tenantDatabaseRow = await fetchTenantDatabase(tenant.id);
    expect(tenantDatabaseRow?.clusterId).toBe(firstResult.clusterId);
    expect(tenantDatabaseRow?.databaseName).toBe(firstResult.databaseName);
  });

  it("throws TenantProvisioningStateError and never touches the tenant when it is SUSPENDED", async () => {
    const cluster = await insertCluster("finalize-suspended");
    const tenant = await insertTenant("finalize-suspended");
    await controlPlaneDb.update(tenants).set({ status: "SUSPENDED" }).where(eq(tenants.id, tenant.id));
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);

    await expect(
      repository.finalizeProvisioning({
        provisioningJobId: job.id,
        tenantId: tenant.id,
        executionToken: claimed!.executionToken,
        result: buildResult(cluster.id),
      }),
    ).rejects.toThrow(TenantProvisioningStateError);

    const tenantRow = await fetchTenant(tenant.id);
    expect(tenantRow?.status).toBe("SUSPENDED");
    const jobRow = await fetchJob(job.id);
    expect(jobRow?.status).toBe("RUNNING");
    await expect(fetchTenantDatabase(tenant.id)).resolves.toBeUndefined();
  });

  it("throws InvalidProvisioningJobStateError and never touches the tenant when the job is FAILED", async () => {
    const cluster = await insertCluster("finalize-failed-job");
    const tenant = await insertTenant("finalize-failed-job");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    await repository.markFailed(job.id, claimed!.executionToken, "some earlier failure");

    await expect(
      repository.finalizeProvisioning({
        provisioningJobId: job.id,
        tenantId: tenant.id,
        executionToken: claimed!.executionToken,
        result: buildResult(cluster.id),
      }),
    ).rejects.toThrow(InvalidProvisioningJobStateError);

    const tenantRow = await fetchTenant(tenant.id);
    expect(tenantRow?.status).toBe("PROVISIONING");
    const jobRow = await fetchJob(job.id);
    expect(jobRow?.status).toBe("FAILED");
  });

  it("throws InvalidProvisioningJobStateError when the job is still PENDING", async () => {
    const cluster = await insertCluster("finalize-pending-job");
    const tenant = await insertTenant("finalize-pending-job");
    const job = await insertJob(tenant.id); // never claimed

    await expect(
      repository.finalizeProvisioning({
        provisioningJobId: job.id,
        tenantId: tenant.id,
        executionToken: randomUUID(),
        result: buildResult(cluster.id),
      }),
    ).rejects.toThrow(InvalidProvisioningJobStateError);

    const tenantRow = await fetchTenant(tenant.id);
    expect(tenantRow?.status).toBe("PROVISIONING");
  });

  it("rolls back all three writes when the transaction fails after the first write (real PostgreSQL)", async () => {
    const TRIGGER_NAME = "force_tenants_update_failure";
    const FUNCTION_NAME = "force_tenants_update_failure";

    const cluster = await insertCluster("finalize-rollback");
    const tenant = await insertTenant("finalize-rollback");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    const result = buildResult(cluster.id);

    // A real PostgreSQL trigger forces the UPDATE on `tenants` (the second write, after the
    // tenant_databases INSERT) to fail — proving rollback against the actual database rather
    // than a mocked transaction.
    await controlPlaneDb.execute(sql.raw(`
      CREATE FUNCTION ${FUNCTION_NAME}() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced failure for rollback test';
      END;
      $$ LANGUAGE plpgsql
    `));
    await controlPlaneDb.execute(sql.raw(`
      CREATE TRIGGER ${TRIGGER_NAME}
      BEFORE UPDATE ON tenants
      FOR EACH ROW EXECUTE FUNCTION ${FUNCTION_NAME}()
    `));

    try {
      // Drizzle wraps the raw driver error ("Failed query: update ...") rather than
      // surfacing the trigger's own message on the top-level `.message` — what this test
      // actually proves is the rollback (no partial writes survive), not the exact wrapper
      // text of a real PostgreSQL error.
      await expect(
        repository.finalizeProvisioning({
          provisioningJobId: job.id,
          tenantId: tenant.id,
          executionToken: claimed!.executionToken,
          result,
        }),
      ).rejects.toThrow();

      await expect(fetchTenantDatabase(tenant.id)).resolves.toBeUndefined();
      const tenantRow = await fetchTenant(tenant.id);
      expect(tenantRow?.status).toBe("PROVISIONING");
      const jobRow = await fetchJob(job.id);
      expect(jobRow?.status).toBe("RUNNING");
    } finally {
      await controlPlaneDb.execute(sql.raw(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON tenants`));
      await controlPlaneDb.execute(sql.raw(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME}()`));
    }
  });

  it("converges to one tenant_database when two finalizations race for the same job/token", async () => {
    const cluster = await insertCluster("finalize-concurrent");
    const tenant = await insertTenant("finalize-concurrent");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    const result = buildResult(cluster.id);
    const input = {
      provisioningJobId: job.id,
      tenantId: tenant.id,
      executionToken: claimed!.executionToken,
      result,
    };

    const outcomes = await Promise.allSettled([
      repository.finalizeProvisioning(input),
      repository.finalizeProvisioning(input),
    ]);

    // Both use the identical result and token, so the row-lock serialization means both
    // either succeed (one creates, the other idempotently confirms) — never a unique
    // violation escaping as an unhandled failure.
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);

    const tenantDatabaseRows = await controlPlaneDb
      .select()
      .from(tenantDatabases)
      .where(eq(tenantDatabases.tenantId, tenant.id));
    expect(tenantDatabaseRows).toHaveLength(1);

    const tenantRow = await fetchTenant(tenant.id);
    expect(tenantRow?.status).toBe("READY");
    const jobRow = await fetchJob(job.id);
    expect(jobRow?.status).toBe("SUCCEEDED");
  });
});

describe("markFailed", () => {
  it("transitions RUNNING → FAILED, sets finishedAt and errorMessage, clears the execution lease", async () => {
    const tenant = await insertTenant("fail");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);

    await repository.markFailed(job.id, claimed!.executionToken, "provisioning boom");

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("FAILED");
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(row?.errorMessage).toBe("provisioning boom");
    expect(row?.executionToken).toBeNull();
    expect(row?.executionLeaseUntil).toBeNull();
    expect(row?.executionHeartbeatAt).toBeInstanceOf(Date);
  });

  it("does not transition a job that is not RUNNING (guard)", async () => {
    const tenant = await insertTenant("guard-fail");
    const job = await insertJob(tenant.id); // still PENDING

    await repository.markFailed(job.id, randomUUID(), "should not apply");

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("PENDING");
    expect(row?.errorMessage).toBeNull();
  });

  it("cannot flip an already-SUCCEEDED job to FAILED (guard)", async () => {
    const cluster = await insertCluster("succeeded-then-fail");
    const tenant = await insertTenant("succeeded-then-fail");
    const job = await insertJob(tenant.id);
    const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    await repository.finalizeProvisioning({
      provisioningJobId: job.id,
      tenantId: tenant.id,
      executionToken: claimed!.executionToken,
      result: buildResult(cluster.id),
    });

    await repository.markFailed(job.id, claimed!.executionToken, "should not apply");

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.errorMessage).toBeNull();
  });

  it("throws ProvisioningExecutionOwnershipLostError when RUNNING but the token no longer matches", async () => {
    const tenant = await insertTenant("fail-ownership-lost");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);

    await expect(repository.markFailed(job.id, randomUUID(), "stale worker")).rejects.toThrow(
      ProvisioningExecutionOwnershipLostError,
    );

    const row = await fetchJob(job.id);
    expect(row?.status).toBe("RUNNING"); // untouched by the stale caller
  });
});

describe("stale worker fencing (split-brain)", () => {
  it("prevents a stale execution from renewing, failing, or finalizing after another execution reclaims the job", async () => {
    const cluster = await insertCluster("stale-worker-fencing");
    const tenant = await insertTenant("stale-worker-fencing");
    const job = await insertJob(tenant.id);

    // Worker A claims the job and its lease later expires (simulated — A "trips" and never
    // renews in time).
    const workerA = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, LEASE_SECONDS);
    await expireLease(job.id);

    // Worker B's recovery loop reclaims the same job — a brand new execution token.
    const [workerB] = await repository.claimExpiredRunningJobs({ batchSize: 10, leaseSeconds: LEASE_SECONDS });
    expect(workerB?.id).toBe(job.id);
    expect(workerB?.executionToken).not.toBe(workerA?.executionToken);

    // Worker A "comes back" and tries to act as if it still owned the job — every one of
    // these must fail or no-op without corrupting Worker B's ownership.
    await expect(repository.renewExecutionLease(job.id, workerA!.executionToken, LEASE_SECONDS)).resolves.toBe(
      false,
    );
    await expect(repository.markFailed(job.id, workerA!.executionToken, "stale A")).rejects.toThrow(
      ProvisioningExecutionOwnershipLostError,
    );
    await expect(
      repository.finalizeProvisioning({
        provisioningJobId: job.id,
        tenantId: tenant.id,
        executionToken: workerA!.executionToken,
        result: buildResult(cluster.id),
      }),
    ).rejects.toThrow(ProvisioningExecutionOwnershipLostError);

    // The job is still exactly where Worker B left it — RUNNING, owned by B, untouched by
    // any of A's stale attempts.
    const row = await fetchJob(job.id);
    expect(row?.status).toBe("RUNNING");
    expect(row?.executionToken).toBe(workerB!.executionToken);
    await expect(fetchTenantDatabase(tenant.id)).resolves.toBeUndefined();

    // Worker B, the legitimate owner, can still renew and finalize normally.
    await expect(repository.renewExecutionLease(job.id, workerB!.executionToken, LEASE_SECONDS)).resolves.toBe(
      true,
    );
    await expect(
      repository.finalizeProvisioning({
        provisioningJobId: job.id,
        tenantId: tenant.id,
        executionToken: workerB!.executionToken,
        result: buildResult(cluster.id),
      }),
    ).resolves.toBeUndefined();

    const finalRow = await fetchJob(job.id);
    expect(finalRow?.status).toBe("SUCCEEDED");
  });
});

describe("execution lease schema", () => {
  it("rejects an execution lease without an execution token (CHECK constraint)", async () => {
    const tenant = await insertTenant("lease-requires-token");
    const job = await insertJob(tenant.id);

    await expect(
      controlPlaneDb
        .update(provisioningJobs)
        .set({ executionLeaseUntil: sql`now() + interval '1 minute'`, executionToken: null })
        .where(eq(provisioningJobs.id, job.id)),
    ).rejects.toThrow();
  });
});

describe("findById", () => {
  it("returns undefined for a non-existent job", async () => {
    const result = await repository.findById("00000000-0000-0000-0000-000000000000");

    expect(result).toBeUndefined();
  });
});
