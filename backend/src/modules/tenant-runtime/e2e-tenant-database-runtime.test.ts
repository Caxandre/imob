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
import { users } from "../../infrastructure/database/tenant/schema.js";
import { createClusterAdminCredentialResolver } from "../provisioning/application/cluster-admin-credential-resolver.js";
import { startPendingProvisioningJob } from "../provisioning/application/process-provisioning-job.js";
import type { DatabaseProvisioner, ProcessProvisioningJobRepository } from "../provisioning/application/process-provisioning-job.js";
import { buildProvisioningResourceNames } from "../provisioning/application/provisioning-resource-names.js";
import type { SecretStore } from "../provisioning/application/secret-store.js";
import { createTenantDatabaseCredentialResolver } from "../provisioning/application/tenant-database-credential-resolver.js";
import { createDrizzleDatabaseClusterSelector } from "../provisioning/infrastructure/drizzle-database-cluster-selector.js";
import { createDrizzleProcessProvisioningJobRepository } from "../provisioning/infrastructure/drizzle-process-provisioning-job-repository.js";
import { createPostgresDatabaseProvisioner } from "../provisioning/infrastructure/postgres-database-provisioner.js";
import { createPostgresTenantDatabaseHealthChecker } from "../provisioning/infrastructure/postgres-tenant-database-health-checker.js";
import { createPostgresTenantDatabaseProvisioner } from "../provisioning/infrastructure/postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "../provisioning/infrastructure/postgres-tenant-role-provisioner.js";
import { createInMemorySecretStore } from "../provisioning/test-support/in-memory-secret-store.js";
import { createDrizzleTenantRepository } from "../tenants/infrastructure/drizzle-tenant-repository.js";
import type { Tenant } from "../tenants/domain/tenant.js";
import { TenantNotReadyError } from "./application/tenant-database-resolver.js";
import { createDrizzleTenantDatabaseResolver } from "./infrastructure/drizzle-tenant-database-resolver.js";
import { createPgTenantDatabaseConnectionManager } from "./infrastructure/pg-tenant-database-connection-manager.js";

/**
 * Full, real-infrastructure proof of this task's central rule: runtime access to a tenant's
 * physical database always goes tenant → `tenant_databases` → runtime connection, using only
 * the tenant application credential, isolated end to end from every other tenant. Reuses the
 * exact real-provisioning setup from `../provisioning/e2e-provisioning.test.ts` to get genuine
 * `READY` tenants — nothing about the runtime resolver/connection manager is exercised against
 * fixtures here, only against tenants that actually went through the real pipeline.
 */
const CLUSTER_NAME = "e2e-tenant-runtime-test-cluster";
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

/** Mirrors the provisioner-level cross-database proof (postgres-tenant-database-provisioner.test.ts) at this new runtime layer — the isolation this task depends on must still hold here. */
async function canConnect(username: string, password: string, databaseName: string): Promise<boolean> {
  const client = new Client({
    host: TENANTS_HOST,
    port: TENANTS_PORT,
    database: databaseName,
    user: username,
    password,
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
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

async function setupCluster(): Promise<{ secretStore: SecretStore }> {
  await controlPlaneDb.insert(databaseClusters).values({
    name: CLUSTER_NAME,
    status: "ACTIVE",
    provider: "local",
    region: "local",
    host: TENANTS_HOST,
    port: TENANTS_PORT,
    secretReference: ADMIN_SECRET_REFERENCE,
  });

  const secretStore = createInMemorySecretStore();
  await secretStore.put(ADMIN_SECRET_REFERENCE, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  return { secretStore };
}

function buildRealProvisioningPipeline(secretStore: SecretStore): {
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

/** Drives a brand-new tenant all the way to real READY, exactly like the BullMQ worker would. */
async function provisionReadyTenant(slugPrefix: string, secretStore: SecretStore): Promise<Tenant> {
  const tenantRepository = createDrizzleTenantRepository(controlPlaneDb);
  const tenant = await tenantRepository.createWithProvisioningIntent({
    name: `Runtime E2E ${slugPrefix}`,
    slug: `${slugPrefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  });
  trackTenantResources(tenant.id);

  const [job] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.tenantId, tenant.id));
  if (!job) {
    throw new Error("provisioning job was not created alongside the tenant");
  }

  const { databaseProvisioner, repository } = buildRealProvisioningPipeline(secretStore);
  const outcome = await startPendingProvisioningJob(
    repository,
    databaseProvisioner,
    { provisioningJobId: job.id, tenantId: tenant.id },
    { leaseSeconds: LEASE_SECONDS, heartbeatIntervalMs: 999_999 },
  );
  if (outcome.outcome !== "succeeded") {
    throw new Error(`expected provisioning to succeed for "${slugPrefix}", got ${JSON.stringify(outcome)}`);
  }

  return tenant;
}

describe("End-to-end tenant database runtime", () => {
  it("resolves two independently provisioned tenants and keeps their data fully isolated (A/B)", async () => {
    const { secretStore } = await setupCluster();
    const tenantA = await provisionReadyTenant("runtime-a", secretStore);
    const tenantB = await provisionReadyTenant("runtime-b", secretStore);

    const resolver = createDrizzleTenantDatabaseResolver(controlPlaneDb);
    const connectionManager = createPgTenantDatabaseConnectionManager({
      credentialResolver: createTenantDatabaseCredentialResolver(secretStore),
    });

    try {
      const targetA = await resolver.resolve(tenantA.id);
      const targetB = await resolver.resolve(tenantB.id);

      const namesA = buildProvisioningResourceNames(tenantA.id);
      const namesB = buildProvisioningResourceNames(tenantB.id);
      expect(targetA).toMatchObject({
        tenantId: tenantA.id,
        databaseName: namesA.databaseName,
        secretReference: namesA.secretReference,
        schemaVersion: 5,
      });
      expect(targetB).toMatchObject({
        tenantId: tenantB.id,
        databaseName: namesB.databaseName,
        secretReference: namesB.secretReference,
        schemaVersion: 5,
      });

      // Real, typed Drizzle queries against the actual Tenant Data Plane schema (users) —
      // never Control Plane tables, which this `TenantDatabase` type cannot even reference.
      await connectionManager.withTenantDatabase(targetA, async (db) => {
        await db.insert(users).values({ email: "a@example.com", name: "Tenant A User" });
      });
      await connectionManager.withTenantDatabase(targetB, async (db) => {
        await db.insert(users).values({ email: "b@example.com", name: "Tenant B User" });
      });

      const rowsA = await connectionManager.withTenantDatabase(targetA, (db) => db.select().from(users));
      const rowsB = await connectionManager.withTenantDatabase(targetB, (db) => db.select().from(users));

      expect(rowsA.map((row) => row.email)).toEqual(["a@example.com"]);
      expect(rowsB.map((row) => row.email)).toEqual(["b@example.com"]);
    } finally {
      await connectionManager.close();
    }
  });

  it("revalidates cross-database protection through the runtime layer — credential A can never reach database B", async () => {
    const { secretStore } = await setupCluster();
    const tenantA = await provisionReadyTenant("runtime-cross-a", secretStore);
    const tenantB = await provisionReadyTenant("runtime-cross-b", secretStore);

    const resolver = createDrizzleTenantDatabaseResolver(controlPlaneDb);
    const targetA = await resolver.resolve(tenantA.id);
    const targetB = await resolver.resolve(tenantB.id);
    const credentialResolver = createTenantDatabaseCredentialResolver(secretStore);
    const credentialA = await credentialResolver.resolve(targetA.secretReference);
    const credentialB = await credentialResolver.resolve(targetB.secretReference);

    await expect(canConnect(credentialA.username, credentialA.password, targetA.databaseName)).resolves.toBe(true);
    await expect(canConnect(credentialB.username, credentialB.password, targetB.databaseName)).resolves.toBe(true);
    await expect(canConnect(credentialA.username, credentialA.password, targetB.databaseName)).resolves.toBe(false);
    await expect(canConnect(credentialB.username, credentialB.password, targetA.databaseName)).resolves.toBe(false);
  });

  it("stops permitting resolution the moment a tenant is suspended, even with an already-cached pool", async () => {
    const { secretStore } = await setupCluster();
    const tenant = await provisionReadyTenant("runtime-suspend", secretStore);

    const resolver = createDrizzleTenantDatabaseResolver(controlPlaneDb);
    const connectionManager = createPgTenantDatabaseConnectionManager({
      credentialResolver: createTenantDatabaseCredentialResolver(secretStore),
    });

    try {
      const target = await resolver.resolve(tenant.id);
      await connectionManager.withTenantDatabase(target, async (db) => {
        await db.execute(sql`select 1`);
      });

      await controlPlaneDb.update(tenants).set({ status: "SUSPENDED" }).where(eq(tenants.id, tenant.id));

      // The connection manager itself would still happily reuse its cached pool for this
      // tenant if handed the same (now-stale) target again — authorization is enforced by
      // always calling resolve() fresh before withTenantDatabase(), never by the pool cache
      // (this task, sections 27/28), which is exactly what this asserts.
      await expect(resolver.resolve(tenant.id)).rejects.toBeInstanceOf(TenantNotReadyError);
    } finally {
      await connectionManager.close();
    }
  });
});
