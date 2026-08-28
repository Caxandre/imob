import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestApp } from "../app/test-support/build-test-app.js";
import { env } from "../config/env.js";
import { controlPlaneDb, controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { databaseClusters, provisioningJobs, tenantDatabases, tenants } from "../infrastructure/database/control-plane/schema.js";
import { createClusterAdminCredentialResolver } from "../modules/provisioning/application/cluster-admin-credential-resolver.js";
import { startPendingProvisioningJob } from "../modules/provisioning/application/process-provisioning-job.js";
import { buildProvisioningResourceNames } from "../modules/provisioning/application/provisioning-resource-names.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import { createDrizzleDatabaseClusterSelector } from "../modules/provisioning/infrastructure/drizzle-database-cluster-selector.js";
import { createDrizzleProcessProvisioningJobRepository } from "../modules/provisioning/infrastructure/drizzle-process-provisioning-job-repository.js";
import { createPostgresDatabaseProvisioner } from "../modules/provisioning/infrastructure/postgres-database-provisioner.js";
import { createPostgresTenantDatabaseHealthChecker } from "../modules/provisioning/infrastructure/postgres-tenant-database-health-checker.js";
import { createPostgresTenantDatabaseProvisioner } from "../modules/provisioning/infrastructure/postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "../modules/provisioning/infrastructure/postgres-tenant-role-provisioner.js";
import { createInMemorySecretStore } from "../modules/provisioning/test-support/in-memory-secret-store.js";
import { bootstrapLocalDevCluster, type LocalDevClusterBootstrapConfig } from "./dev-full-bootstrap.js";

/**
 * Real infrastructure throughout (same pattern as `property-routes.test.ts`): a real Control
 * Plane database and a real `postgres-tenants` cluster, never mocks. `silentLogger` only
 * satisfies `bootstrapLocalDevCluster`'s `Logger` parameter — its output is irrelevant here.
 */
const TENANTS_HOST = "localhost";
const TENANTS_PORT = 5433;
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";
const LEASE_SECONDS = 60;
const silentLogger = pino({ level: "silent" });

const createdDatabaseNames = new Set<string>();
const createdRoleNames = new Set<string>();

function trackTenantResources(tenantId: string): void {
  const names = buildProvisioningResourceNames(tenantId);
  createdDatabaseNames.add(names.databaseName);
  createdRoleNames.add(names.roleName);
}

function bootstrapConfig(overrides: Partial<LocalDevClusterBootstrapConfig> = {}): LocalDevClusterBootstrapConfig {
  return {
    clusterName: env.TENANT_DATABASE_DEFAULT_CLUSTER,
    host: TENANTS_HOST,
    port: TENANTS_PORT,
    adminUsername: ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
    ...overrides,
  };
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

  const client = new Client({
    host: TENANTS_HOST,
    port: TENANTS_PORT,
    database: "postgres",
    user: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  });
  await client.connect();
  try {
    for (const databaseName of databaseNames) {
      await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(databaseName)} WITH (FORCE)`);
    }
    for (const roleName of roleNames) {
      await client.query(`DROP ROLE IF EXISTS ${escapeIdentifier(roleName)}`);
    }
  } finally {
    await client.end();
  }
});

afterAll(async () => {
  await controlPlanePool.end();
});

describe("bootstrapLocalDevCluster", () => {
  it("creates the database_clusters row when missing", async () => {
    const secretStore = createInMemorySecretStore();

    await bootstrapLocalDevCluster(secretStore, silentLogger, bootstrapConfig());

    const [cluster] = await controlPlaneDb
      .select()
      .from(databaseClusters)
      .where(eq(databaseClusters.name, env.TENANT_DATABASE_DEFAULT_CLUSTER));

    expect(cluster).toMatchObject({
      name: env.TENANT_DATABASE_DEFAULT_CLUSTER,
      status: "ACTIVE",
      host: TENANTS_HOST,
      port: TENANTS_PORT,
      secretReference: `clusters/${env.TENANT_DATABASE_DEFAULT_CLUSTER}`,
    });
  });

  it("is idempotent — calling it twice never errors and never creates a duplicate row", async () => {
    const secretStore = createInMemorySecretStore();

    await bootstrapLocalDevCluster(secretStore, silentLogger, bootstrapConfig());
    await expect(bootstrapLocalDevCluster(secretStore, silentLogger, bootstrapConfig())).resolves.toBeUndefined();

    const rows = await controlPlaneDb
      .select()
      .from(databaseClusters)
      .where(eq(databaseClusters.name, env.TENANT_DATABASE_DEFAULT_CLUSTER));
    expect(rows).toHaveLength(1);
  });

  it("never overwrites an already-existing row's host/port on a later call", async () => {
    const secretStore = createInMemorySecretStore();
    await bootstrapLocalDevCluster(secretStore, silentLogger, bootstrapConfig({ port: TENANTS_PORT }));

    // Simulates a changed env var on a later restart — the already-existing row must win, an
    // operator's manually customized row is never silently reset (this task's design).
    await bootstrapLocalDevCluster(secretStore, silentLogger, bootstrapConfig({ port: 9999 }));

    const [cluster] = await controlPlaneDb
      .select()
      .from(databaseClusters)
      .where(eq(databaseClusters.name, env.TENANT_DATABASE_DEFAULT_CLUSTER));
    expect(cluster?.port).toBe(TENANTS_PORT);
  });

  it("seeds the admin credential into the SecretStore under the row's secretReference", async () => {
    const secretStore = createInMemorySecretStore();

    await bootstrapLocalDevCluster(secretStore, silentLogger, bootstrapConfig());

    await expect(secretStore.get(`clusters/${env.TENANT_DATABASE_DEFAULT_CLUSTER}`)).resolves.toEqual({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    });
  });

  it("re-seeds the credential into a fresh SecretStore even when the row already exists (simulating a dev-full restart)", async () => {
    const firstProcessSecretStore = createInMemorySecretStore();
    await bootstrapLocalDevCluster(firstProcessSecretStore, silentLogger, bootstrapConfig());

    // A restarted process starts with a brand-new, empty in-memory SecretStore — the
    // database_clusters row, however, is real PostgreSQL state and survives the restart.
    const secondProcessSecretStore = createInMemorySecretStore();
    await bootstrapLocalDevCluster(secondProcessSecretStore, silentLogger, bootstrapConfig());

    await expect(secondProcessSecretStore.get(`clusters/${env.TENANT_DATABASE_DEFAULT_CLUSTER}`)).resolves.toEqual({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    });
  });
});

describe("end-to-end via the real HTTP app", () => {
  it("after bootstrap, POST /api/v1/tenants provisions a real database and the tenant becomes READY", async () => {
    const secretStore = createInMemorySecretStore();
    await bootstrapLocalDevCluster(secretStore, silentLogger, bootstrapConfig());

    const app = buildTestApp(secretStore);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tenants",
        payload: { name: "Dev Bootstrap E2E", slug: `dev-bootstrap-${Date.now()}` },
      });
      expect(response.statusCode).toBe(201);
      const tenantId = response.json().id as string;
      trackTenantResources(tenantId);

      const [job] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.tenantId, tenantId));
      if (!job) {
        throw new Error("provisioning job was not created alongside the tenant");
      }

      // Drives the real provisioning pipeline directly (no dispatcher/BullMQ round trip needed
      // to prove the bootstrap closes the credential gap) — same composition
      // `createProvisioningWorkerRuntime`/`property-routes.test.ts` use, built from the exact
      // `secretStore` bootstrap just seeded.
      const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
      const databaseProvisioner = createPostgresDatabaseProvisioner({
        clusterSelector: createDrizzleDatabaseClusterSelector(controlPlaneDb, env.TENANT_DATABASE_DEFAULT_CLUSTER),
        clusterAdminCredentialResolver,
        tenantRoleProvisioner: createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver }),
        tenantDatabaseProvisioner: createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver }),
        tenantDatabaseCredentialResolver: createTenantDatabaseCredentialResolver(secretStore),
        healthChecker: createPostgresTenantDatabaseHealthChecker(),
      });
      const repository = createDrizzleProcessProvisioningJobRepository(controlPlaneDb);

      const outcome = await startPendingProvisioningJob(
        repository,
        databaseProvisioner,
        { provisioningJobId: job.id, tenantId },
        { leaseSeconds: LEASE_SECONDS, heartbeatIntervalMs: 999_999 },
      );
      expect(outcome.outcome).toBe("succeeded");

      const [tenantRow] = await controlPlaneDb.select().from(tenants).where(eq(tenants.id, tenantId));
      expect(tenantRow?.status).toBe("READY");

      // The tenant's physical database really exists — connect to it directly, independent of
      // any application code path.
      const names = buildProvisioningResourceNames(tenantId);
      const client = new Client({
        host: TENANTS_HOST,
        port: TENANTS_PORT,
        database: names.databaseName,
        user: ADMIN_USERNAME,
        password: ADMIN_PASSWORD,
      });
      await client.connect();
      try {
        const result = await client.query("SELECT current_database()");
        expect(result.rows[0]?.current_database).toBe(names.databaseName);
      } finally {
        await client.end();
      }
    } finally {
      await app.close();
    }
  });
});
