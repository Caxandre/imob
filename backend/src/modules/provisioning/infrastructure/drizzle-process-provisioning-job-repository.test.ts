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
  ProvisioningFinalizationConflictError,
  TenantProvisioningStateError,
} from "../application/process-provisioning-job.js";
import type { ProvisioningResult } from "../application/provisioning-result.js";
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

describe("finalizeProvisioning", () => {
  it("atomically creates tenant_databases READY, marks tenant READY, and job SUCCEEDED", async () => {
    const cluster = await insertCluster("finalize-happy-path");
    const tenant = await insertTenant("finalize-happy-path");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);
    const result = buildResult(cluster.id);

    await repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result });

    const tenantRow = await fetchTenant(tenant.id);
    expect(tenantRow?.status).toBe("READY");

    const jobRow = await fetchJob(job.id);
    expect(jobRow?.status).toBe("SUCCEEDED");
    expect(jobRow?.finishedAt).toBeInstanceOf(Date);
    expect(jobRow?.errorMessage).toBeNull();

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

  it("is idempotent: a second call with the same result changes nothing and does not error", async () => {
    const cluster = await insertCluster("finalize-idempotent");
    const tenant = await insertTenant("finalize-idempotent");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);
    const result = buildResult(cluster.id);

    await repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result });
    await expect(
      repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result }),
    ).resolves.toBeUndefined();

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

  it("throws ProvisioningFinalizationConflictError when an existing tenant_databases row disagrees with the result", async () => {
    const cluster = await insertCluster("finalize-conflict");
    const otherCluster = await insertCluster("finalize-conflict-other");
    const tenant = await insertTenant("finalize-conflict");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);
    const firstResult = buildResult(cluster.id);
    await repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result: firstResult });

    const conflictingResult = buildResult(otherCluster.id);

    await expect(
      repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result: conflictingResult }),
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
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);

    await expect(
      repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result: buildResult(cluster.id) }),
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
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);
    await repository.markFailed(job.id, "some earlier failure");

    await expect(
      repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result: buildResult(cluster.id) }),
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
      repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result: buildResult(cluster.id) }),
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
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);
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
        repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result }),
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

  it("converges to one tenant_database when two finalizations race for the same job", async () => {
    const cluster = await insertCluster("finalize-concurrent");
    const tenant = await insertTenant("finalize-concurrent");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);
    const result = buildResult(cluster.id);

    const outcomes = await Promise.allSettled([
      repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result }),
      repository.finalizeProvisioning({ provisioningJobId: job.id, tenantId: tenant.id, result }),
    ]);

    // Both use the identical result, so the row-lock serialization means both either
    // succeed (one creates, the other idempotently confirms) — never a unique violation
    // escaping as an unhandled failure.
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
    const cluster = await insertCluster("succeeded-then-fail");
    const tenant = await insertTenant("succeeded-then-fail");
    const job = await insertJob(tenant.id);
    await repository.markRunning(job.id, PROVISION_DATABASE_STEP);
    await repository.finalizeProvisioning({
      provisioningJobId: job.id,
      tenantId: tenant.id,
      result: buildResult(cluster.id),
    });

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
