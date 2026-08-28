import { Client, escapeIdentifier } from "pg";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  provisioningJobs,
  tenantDatabases,
  tenants,
} from "../../infrastructure/database/control-plane/schema.js";
import { createDrizzleTenantRepository } from "../tenants/infrastructure/drizzle-tenant-repository.js";
import { createClusterAdminCredentialResolver } from "./application/cluster-admin-credential-resolver.js";
import { startPendingProvisioningJob } from "./application/process-provisioning-job.js";
import type { DatabaseProvisioner, ProcessProvisioningJobRepository } from "./application/process-provisioning-job.js";
import { buildProvisioningResourceNames } from "./application/provisioning-resource-names.js";
import { recoverExpiredRunningJobsOnce } from "./application/recover-provisioning-jobs.js";
import { createTenantDatabaseCredentialResolver } from "./application/tenant-database-credential-resolver.js";
import { createDrizzleDatabaseClusterSelector } from "./infrastructure/drizzle-database-cluster-selector.js";
import { createDrizzleProcessProvisioningJobRepository } from "./infrastructure/drizzle-process-provisioning-job-repository.js";
import { createPostgresDatabaseProvisioner } from "./infrastructure/postgres-database-provisioner.js";
import { createPostgresTenantDatabaseHealthChecker } from "./infrastructure/postgres-tenant-database-health-checker.js";
import { createPostgresTenantDatabaseProvisioner } from "./infrastructure/postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "./infrastructure/postgres-tenant-role-provisioner.js";
import { createInMemorySecretStore } from "./test-support/in-memory-secret-store.js";
import type { SecretStore } from "./application/secret-store.js";

/**
 * The first fully real, end-to-end tests of tenant provisioning: tenant creation (Control
 * Plane transaction) → `startPendingProvisioningJob` → the real, composed `DatabaseProvisioner`
 * (Prompt 017, real role/database/migrations/permissions/health check against
 * `postgres-tenants`) → the real Control Plane finalization transaction (Prompt 018) → real
 * execution lease/recovery (Prompt 019). Redis/BullMQ are deliberately not involved — the
 * application-layer functions are called directly, exactly as the worker/recovery loop would.
 * Nothing here is mocked except `SecretStore` (in-memory, test-support only).
 */
const CLUSTER_NAME = "e2e-provisioning-test-cluster";
const ADMIN_SECRET_REFERENCE = `clusters/${CLUSTER_NAME}`;
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";
const TENANTS_HOST = "localhost";
const TENANTS_PORT = 5433;
const LEASE_SECONDS = 60;

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: TENANTS_HOST,
    port: TENANTS_PORT,
    database: "postgres",
    user: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const createdDatabaseNames = new Set<string>();
const createdRoleNames = new Set<string>();

function trackTenantResources(tenantId: string): void {
  const names = buildProvisioningResourceNames(tenantId);
  createdDatabaseNames.add(names.databaseName);
  createdRoleNames.add(names.roleName);
}

beforeEach(async () => {
  await controlPlaneDb.execute(
    sql`TRUNCATE TABLE ${provisioningJobs}, ${tenantDatabases}, ${tenants}, ${databaseClusters} CASCADE`,
  );
});

afterEach(async () => {
  const databaseNames = [...createdDatabaseNames];
  const roleNames = [...createdRoleNames];
  createdDatabaseNames.clear();
  createdRoleNames.clear();

  await withAdminClient(async (client) => {
    for (const databaseName of databaseNames) {
      await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(databaseName)} WITH (FORCE)`);
    }
    for (const roleName of roleNames) {
      await client.query(`DROP ROLE IF EXISTS ${escapeIdentifier(roleName)}`);
    }
  });

  await controlPlaneDb.execute(sql`TRUNCATE TABLE ${databaseClusters} CASCADE`);
});

afterAll(async () => {
  await controlPlanePool.end();
});

/** Real infra setup every test in this file needs: an ACTIVE cluster + its admin secret. */
async function setupCluster(): Promise<{ clusterId: string; secretStore: SecretStore }> {
  const [cluster] = await controlPlaneDb
    .insert(databaseClusters)
    .values({
      name: CLUSTER_NAME,
      status: "ACTIVE",
      provider: "local",
      region: "local",
      host: TENANTS_HOST,
      port: TENANTS_PORT,
      secretReference: ADMIN_SECRET_REFERENCE,
    })
    .returning();
  if (!cluster) {
    throw new Error("cluster insert returned no row");
  }

  const secretStore = createInMemorySecretStore();
  await secretStore.put(ADMIN_SECRET_REFERENCE, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  return { clusterId: cluster.id, secretStore };
}

/** The real, composed DatabaseProvisioner (Prompt 017) + repository (Prompt 018/019) — every piece real. */
function buildRealPipeline(secretStore: SecretStore): {
  databaseProvisioner: DatabaseProvisioner;
  repository: ProcessProvisioningJobRepository;
} {
  const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
  const databaseProvisioner = createPostgresDatabaseProvisioner({
    clusterSelector: createDrizzleDatabaseClusterSelector(controlPlaneDb, CLUSTER_NAME),
    clusterAdminCredentialResolver,
    tenantRoleProvisioner: createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver }),
    tenantDatabaseProvisioner: createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver }),
    tenantDatabaseCredentialResolver: createTenantDatabaseCredentialResolver(secretStore),
    healthChecker: createPostgresTenantDatabaseHealthChecker(),
  });
  return { databaseProvisioner, repository: createDrizzleProcessProvisioningJobRepository(controlPlaneDb) };
}

async function createTenantWithJob(slugPrefix: string) {
  const tenantRepository = createDrizzleTenantRepository(controlPlaneDb);
  const tenant = await tenantRepository.createWithProvisioningIntent({
    name: `E2E ${slugPrefix} Tenant`,
    slug: `${slugPrefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  });
  trackTenantResources(tenant.id);

  const [job] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.tenantId, tenant.id));
  if (!job) {
    throw new Error("provisioning job was not created alongside the tenant");
  }

  return { tenant, job };
}

describe("End-to-end tenant provisioning", () => {
  it("takes a tenant from creation to READY with a real database, role, migrations, and health check", async () => {
    const { clusterId, secretStore } = await setupCluster();
    const { tenant, job } = await createTenantWithJob("e2e-provisioning");
    expect(tenant.status).toBe("PROVISIONING");
    expect(job.status).toBe("PENDING");

    const { databaseProvisioner, repository } = buildRealPipeline(secretStore);

    // Exactly what the BullMQ worker calls — driving PENDING all the way to SUCCEEDED,
    // including the real Control Plane finalization transaction (Prompt 018) and a real
    // execution lease/heartbeat for the duration (Prompt 019).
    const outcome = await startPendingProvisioningJob(
      repository,
      databaseProvisioner,
      { provisioningJobId: job.id, tenantId: tenant.id },
      { leaseSeconds: LEASE_SECONDS, heartbeatIntervalMs: 999_999 },
    );

    expect(outcome).toEqual({ outcome: "succeeded" });

    const [tenantRow] = await controlPlaneDb.select().from(tenants).where(eq(tenants.id, tenant.id));
    expect(tenantRow?.status).toBe("READY");

    const [jobRow] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.id, job.id));
    expect(jobRow?.status).toBe("SUCCEEDED");
    expect(jobRow?.finishedAt).toBeInstanceOf(Date);
    expect(jobRow?.errorMessage).toBeNull();

    const [tenantDatabaseRow] = await controlPlaneDb
      .select()
      .from(tenantDatabases)
      .where(eq(tenantDatabases.tenantId, tenant.id));
    const expectedNames = buildProvisioningResourceNames(tenant.id);
    expect(tenantDatabaseRow).toMatchObject({
      tenantId: tenant.id,
      clusterId,
      databaseName: expectedNames.databaseName,
      secretReference: expectedNames.secretReference,
      schemaVersion: 5,
      status: "READY",
    });

    // The physical tenant infrastructure genuinely exists — not just the Control Plane
    // bookkeeping. Independently re-verifies via the tenant's own real credential, the same
    // property the health check already proved inside provision().
    const tenantSecret = (await secretStore.get(expectedNames.secretReference)) as {
      username: string;
      password: string;
    };
    const tenantClient = new Client({
      host: TENANTS_HOST,
      port: TENANTS_PORT,
      database: expectedNames.databaseName,
      user: tenantSecret.username,
      password: tenantSecret.password,
    });
    await tenantClient.connect();
    try {
      const tables = await tenantClient.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "audit_logs",
        "outbox_events",
        "properties",
        "property_media",
        "users",
      ]);

      const migrations = await tenantClient.query<{ count: string }>(
        "SELECT count(*) AS count FROM drizzle.__drizzle_migrations",
      );
      expect(Number(migrations.rows[0]?.count)).toBe(5);
    } finally {
      await tenantClient.end();
    }
  });

  it("recovers a job abandoned right after infrastructure was ready but before finalization ran", async () => {
    // Simulates the exact crash gap this task exists to close (ADR-003 "Recovery", sections
    // 29/31): a worker's provision() call already completed for real — role, database,
    // migrations, permissions, health check all genuinely done — but the process died before
    // ever calling finalizeProvisioning(). The job is left RUNNING, with a lease that will
    // eventually expire; a real crash is never simulated by calling processProvisioningJob's
    // higher-level orchestration, only by driving the exact same lower-level steps it would
    // have, then stopping short of finalization on purpose.
    const { secretStore } = await setupCluster();
    const { tenant, job } = await createTenantWithJob("e2e-recovery");
    const { databaseProvisioner, repository } = buildRealPipeline(secretStore);

    const claim = await repository.markRunning(job.id, "PROVISION_DATABASE", LEASE_SECONDS);
    if (!claim) {
      throw new Error("expected to claim the freshly-created PENDING job");
    }
    // Real infrastructure provisioning, real health check — everything Prompt 017 does. No
    // finalizeProvisioning() call follows — this is the simulated crash.
    await databaseProvisioner.provision({ provisioningJobId: job.id, tenantId: tenant.id });

    const [runningJobRow] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.id, job.id));
    expect(runningJobRow?.status).toBe("RUNNING");
    await expect(
      controlPlaneDb.select().from(tenantDatabases).where(eq(tenantDatabases.tenantId, tenant.id)),
    ).resolves.toEqual([]);

    // The lease eventually expires (backdated here instead of actually waiting it out).
    await controlPlaneDb
      .update(provisioningJobs)
      .set({ executionLeaseUntil: sql`now() - interval '1 minute'` })
      .where(eq(provisioningJobs.id, job.id));

    const summary = await recoverExpiredRunningJobsOnce(repository, databaseProvisioner, {
      batchSize: 10,
      leaseSeconds: LEASE_SECONDS,
      heartbeatIntervalMs: 999_999,
    });

    expect(summary.claimedCount).toBe(1);
    expect(summary.results).toEqual([{ id: job.id, tenantId: tenant.id, outcome: { outcome: "succeeded" } }]);

    const [tenantRow] = await controlPlaneDb.select().from(tenants).where(eq(tenants.id, tenant.id));
    expect(tenantRow?.status).toBe("READY");

    const [finalJobRow] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.id, job.id));
    expect(finalJobRow?.status).toBe("SUCCEEDED");
    // The original PENDING → RUNNING claim was attempt 1; the recovery reclaim is a real
    // second execution attempt (this task, section 11) — never bumped again by finalization.
    expect(finalJobRow?.attempts).toBe(2);
    expect(finalJobRow?.executionToken).toBeNull();

    const [tenantDatabaseRow] = await controlPlaneDb
      .select()
      .from(tenantDatabases)
      .where(eq(tenantDatabases.tenantId, tenant.id));
    expect(tenantDatabaseRow?.status).toBe("READY");
  });
});
