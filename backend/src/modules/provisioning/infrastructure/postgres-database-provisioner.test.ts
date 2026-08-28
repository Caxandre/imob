import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  provisioningJobs,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import { createClusterAdminCredentialResolver } from "../application/cluster-admin-credential-resolver.js";
import { buildProvisioningResourceNames } from "../application/provisioning-resource-names.js";
import type { SecretStore } from "../application/secret-store.js";
import { createTenantDatabaseCredentialResolver } from "../application/tenant-database-credential-resolver.js";
import { createInMemorySecretStore } from "../test-support/in-memory-secret-store.js";
import { createDrizzleDatabaseClusterSelector } from "./drizzle-database-cluster-selector.js";
import { createPostgresTenantDatabaseHealthChecker } from "./postgres-tenant-database-health-checker.js";
import { createPostgresTenantDatabaseProvisioner } from "./postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "./postgres-tenant-role-provisioner.js";
import { createPostgresDatabaseProvisioner } from "./postgres-database-provisioner.js";

/**
 * Full composed `DatabaseProvisioner`, tested against real infrastructure end to end — the
 * Control Plane PostgreSQL (for cluster selection) and `postgres-tenants` (for the tenant's
 * role/database/migrations/permissions/health check). Not a mock at any layer: this is
 * exactly the sequence ADR-003 describes, exercised for real.
 */
const CLUSTER_NAME = "postgres-database-provisioner-test-cluster";
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

async function insertCluster(): Promise<void> {
  await controlPlaneDb.insert(databaseClusters).values({
    name: CLUSTER_NAME,
    status: "ACTIVE",
    provider: "local",
    region: "local",
    host: TENANTS_HOST,
    port: TENANTS_PORT,
    secretReference: ADMIN_SECRET_REFERENCE,
  });
}

const createdDatabaseNames = new Set<string>();
const createdRoleNames = new Set<string>();

function freshTenantId(): string {
  const tenantId = randomUUID();
  const names = buildProvisioningResourceNames(tenantId);
  createdDatabaseNames.add(names.databaseName);
  createdRoleNames.add(names.roleName);
  return tenantId;
}

// Other test files in this suite also write to tenants/provisioning_jobs/tenant_databases;
// a clean slate here — independent of execution order — is what lets the "never writes to
// the Control Plane" test below assert these tables are empty after provision().
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

async function seedAdminSecret(secretStore: SecretStore): Promise<void> {
  await secretStore.put(ADMIN_SECRET_REFERENCE, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
}

function buildProvisioner(secretStore: SecretStore) {
  const clusterSelector = createDrizzleDatabaseClusterSelector(controlPlaneDb, CLUSTER_NAME);
  const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
  const tenantRoleProvisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
  const tenantDatabaseProvisioner = createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver });
  const tenantDatabaseCredentialResolver = createTenantDatabaseCredentialResolver(secretStore);
  const healthChecker = createPostgresTenantDatabaseHealthChecker();

  return createPostgresDatabaseProvisioner({
    clusterSelector,
    clusterAdminCredentialResolver,
    tenantRoleProvisioner,
    tenantDatabaseProvisioner,
    tenantDatabaseCredentialResolver,
    healthChecker,
  });
}

describe("createPostgresDatabaseProvisioner", () => {
  it("provisions a brand-new tenant end to end and returns a valid ProvisioningResult", async () => {
    const secretStore = createInMemorySecretStore();
    await seedAdminSecret(secretStore);
    await insertCluster();
    const provisioner = buildProvisioner(secretStore);
    const tenantId = freshTenantId();
    const expectedNames = buildProvisioningResourceNames(tenantId);

    const result = await provisioner.provision({ provisioningJobId: randomUUID(), tenantId });

    expect(result).toEqual({
      clusterId: expect.any(String),
      databaseName: expectedNames.databaseName,
      secretReference: expectedNames.secretReference,
      schemaVersion: 5,
    });

    // Never the cluster admin secret reference — only the tenant's own.
    expect(result.secretReference).not.toBe(ADMIN_SECRET_REFERENCE);

    const savedTenantSecret = await secretStore.get(expectedNames.secretReference);
    expect(savedTenantSecret).toMatchObject({ username: expectedNames.roleName });
  });

  it("never writes to the Control Plane (tenants/provisioning_jobs/tenant_databases)", async () => {
    const secretStore = createInMemorySecretStore();
    await seedAdminSecret(secretStore);
    await insertCluster();
    const provisioner = buildProvisioner(secretStore);
    const tenantId = freshTenantId();

    await provisioner.provision({ provisioningJobId: randomUUID(), tenantId });

    // `database_clusters` has exactly the one row this test itself inserted for cluster
    // selection (infra setup, not something the provisioner wrote) — the three tables the
    // boundary rule actually protects (ADR-003, CLAUDE.md) must remain completely empty.
    await expect(controlPlaneDb.select().from(tenants)).resolves.toHaveLength(0);
    await expect(controlPlaneDb.select().from(provisioningJobs)).resolves.toHaveLength(0);
    await expect(controlPlaneDb.select().from(tenantDatabases)).resolves.toHaveLength(0);
  });

  it("is idempotent: a second run for the same tenant converges without rotating the credential", async () => {
    const secretStore = createInMemorySecretStore();
    await seedAdminSecret(secretStore);
    await insertCluster();
    const provisioner = buildProvisioner(secretStore);
    const tenantId = freshTenantId();

    const first = await provisioner.provision({ provisioningJobId: randomUUID(), tenantId });
    const firstSecret = await secretStore.get(first.secretReference);

    const second = await provisioner.provision({ provisioningJobId: randomUUID(), tenantId });
    const secondSecret = await secretStore.get(second.secretReference);

    expect(second).toEqual(first);
    expect(secondSecret).toEqual(firstSecret);
  });

  it("recovers when the role and database already exist but migrations were never run", async () => {
    const secretStore = createInMemorySecretStore();
    await seedAdminSecret(secretStore);
    await insertCluster();
    const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
    const tenantRoleProvisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
    const tenantDatabaseProvisioner = createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver });
    const tenantId = freshTenantId();
    const cluster = await createDrizzleDatabaseClusterSelector(controlPlaneDb, CLUSTER_NAME).selectClusterFor(
      tenantId,
    );

    // Simulates a crash after CREATE_ROLE/CREATE_DATABASE but before RUN_MIGRATIONS —
    // exactly the partial-failure scenario ADR-003 requires a retry to recover from.
    await tenantRoleProvisioner.ensureRole({ tenantId, cluster });
    await tenantDatabaseProvisioner.ensureDatabase({ tenantId, cluster });

    const provisioner = buildProvisioner(secretStore);
    const result = await provisioner.provision({ provisioningJobId: randomUUID(), tenantId });

    expect(result.schemaVersion).toBe(5);
  });
});
