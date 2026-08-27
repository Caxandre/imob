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
import { processProvisioningJob } from "./application/process-provisioning-job.js";
import { buildProvisioningResourceNames } from "./application/provisioning-resource-names.js";
import { createTenantDatabaseCredentialResolver } from "./application/tenant-database-credential-resolver.js";
import { createDrizzleDatabaseClusterSelector } from "./infrastructure/drizzle-database-cluster-selector.js";
import { createDrizzleProcessProvisioningJobRepository } from "./infrastructure/drizzle-process-provisioning-job-repository.js";
import { createPostgresDatabaseProvisioner } from "./infrastructure/postgres-database-provisioner.js";
import { createPostgresTenantDatabaseHealthChecker } from "./infrastructure/postgres-tenant-database-health-checker.js";
import { createPostgresTenantDatabaseProvisioner } from "./infrastructure/postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "./infrastructure/postgres-tenant-role-provisioner.js";
import { createInMemorySecretStore } from "./test-support/in-memory-secret-store.js";

/**
 * The first fully real, end-to-end test of tenant provisioning (Prompt 018): tenant creation
 * (Control Plane transaction) → `processProvisioningJob` → the real, composed
 * `DatabaseProvisioner` (Prompt 017, real role/database/migrations/permissions/health check
 * against `postgres-tenants`) → the real Control Plane finalization transaction (Prompt 018).
 * Redis/BullMQ are deliberately not involved — `processProvisioningJob` is called directly,
 * exactly as `bullmq-provisioning-worker.ts` would call it, without needing a running queue
 * for this test. Nothing here is mocked except `SecretStore` (in-memory, test-support only).
 */
const CLUSTER_NAME = "e2e-provisioning-test-cluster";
const ADMIN_SECRET_REFERENCE = `clusters/${CLUSTER_NAME}`;
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";
const TENANTS_HOST = "localhost";
const TENANTS_PORT = 5433;

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

describe("End-to-end tenant provisioning", () => {
  it("takes a tenant from creation to READY with a real database, role, migrations, and health check", async () => {
    // 1. Real infra setup this test owns: an ACTIVE cluster pointing at postgres-tenants,
    // and the admin credential a real DatabaseProvisioner needs to resolve it.
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

    // 2. Tenant creation — the real Control Plane transaction (POST /api/v1/tenants' own
    // use case), not a hand-rolled insert.
    const tenantRepository = createDrizzleTenantRepository(controlPlaneDb);
    const tenant = await tenantRepository.createWithProvisioningIntent({
      name: "E2E Provisioning Tenant",
      slug: `e2e-provisioning-${Date.now()}`,
    });
    trackTenantResources(tenant.id);
    expect(tenant.status).toBe("PROVISIONING");

    const [job] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.tenantId, tenant.id));
    if (!job) {
      throw new Error("provisioning job was not created alongside the tenant");
    }
    expect(job.status).toBe("PENDING");

    // 3. The real, composed DatabaseProvisioner (Prompt 017) — every piece real, nothing
    // faked except where the admin secret is stored.
    const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
    const databaseProvisioner = createPostgresDatabaseProvisioner({
      clusterSelector: createDrizzleDatabaseClusterSelector(controlPlaneDb, CLUSTER_NAME),
      clusterAdminCredentialResolver,
      tenantRoleProvisioner: createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver }),
      tenantDatabaseProvisioner: createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver }),
      tenantDatabaseCredentialResolver: createTenantDatabaseCredentialResolver(secretStore),
      healthChecker: createPostgresTenantDatabaseHealthChecker(),
    });
    const repository = createDrizzleProcessProvisioningJobRepository(controlPlaneDb);

    // 4. Exactly what the BullMQ worker calls — driving PENDING all the way to SUCCEEDED,
    // including the real Control Plane finalization transaction (Prompt 018).
    const outcome = await processProvisioningJob(repository, databaseProvisioner, {
      provisioningJobId: job.id,
      tenantId: tenant.id,
    });

    expect(outcome).toEqual({ outcome: "succeeded" });

    // 5. Final Control Plane state.
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
      clusterId: cluster.id,
      databaseName: expectedNames.databaseName,
      secretReference: expectedNames.secretReference,
      schemaVersion: 1,
      status: "READY",
    });

    // 6. The physical tenant infrastructure genuinely exists — not just the Control Plane
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
      expect(tables.rows.map((row) => row.table_name)).toEqual(["audit_logs", "outbox_events", "users"]);

      const migrations = await tenantClient.query<{ count: string }>(
        "SELECT count(*) AS count FROM drizzle.__drizzle_migrations",
      );
      expect(Number(migrations.rows[0]?.count)).toBe(1);
    } finally {
      await tenantClient.end();
    }
  });
});
