import { randomUUID } from "node:crypto";

import { Client, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { grantTenantApplicationPrivileges } from "../../../infrastructure/database/tenant/permissions.js";
import { runTenantMigrations } from "../../../infrastructure/database/tenant/migrate.js";
import type { TenantMigrationTarget } from "../../../infrastructure/database/tenant/migrate.js";
import { createClusterAdminCredentialResolver } from "../application/cluster-admin-credential-resolver.js";
import type { DatabaseCluster } from "../application/database-cluster-selector.js";
import { buildProvisioningResourceNames } from "../application/provisioning-resource-names.js";
import type { SecretStore } from "../application/secret-store.js";
import { TenantDatabaseHealthCheckError } from "../application/tenant-database-health-checker.js";
import { createInMemorySecretStore } from "../test-support/in-memory-secret-store.js";
import { createPostgresTenantDatabaseHealthChecker } from "./postgres-tenant-database-health-checker.js";
import { createPostgresTenantDatabaseProvisioner } from "./postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "./postgres-tenant-role-provisioner.js";

/**
 * Real `postgres-tenants` (Docker Compose), not a mock — health check success/failure must be
 * proven against an actual server (real auth, real `current_database()`, real schema state).
 */
const ADMIN_SECRET_REFERENCE = "clusters/postgres-tenants-test-admin-health-check";
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";

const CLUSTER: DatabaseCluster = {
  id: "00000000-0000-0000-0000-000000000004",
  name: "postgres-tenants-test",
  provider: "local",
  region: "local",
  host: "localhost",
  port: 5433,
  secretReference: ADMIN_SECRET_REFERENCE,
};

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: CLUSTER.host,
    port: CLUSTER.port,
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

function freshTenantId(): string {
  const tenantId = randomUUID();
  const names = buildProvisioningResourceNames(tenantId);
  createdDatabaseNames.add(names.databaseName);
  createdRoleNames.add(names.roleName);
  return tenantId;
}

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
});

function buildDeps() {
  const secretStore = createInMemorySecretStore();
  const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
  return { secretStore, clusterAdminCredentialResolver };
}

async function seedAdminSecret(secretStore: SecretStore): Promise<void> {
  await secretStore.put(ADMIN_SECRET_REFERENCE, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
}

/** Provisions a tenant fully up through permissions — everything this task's scope covers
 * except the health check itself, which each test exercises directly. */
async function provisionTenantUpToPermissions(secretStore: SecretStore, tenantId: string) {
  const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
  const roleProvisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
  const databaseProvisioner = createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver });

  const { roleName, secretReference } = await roleProvisioner.ensureRole({ tenantId, cluster: CLUSTER });
  const { databaseName } = await databaseProvisioner.ensureDatabase({ tenantId, cluster: CLUSTER });
  const { password: rolePassword } = (await secretStore.get(secretReference)) as { password: string };

  const target: TenantMigrationTarget = {
    host: CLUSTER.host,
    port: CLUSTER.port,
    database: databaseName,
    user: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  };

  const { schemaVersion } = await runTenantMigrations(target);
  await grantTenantApplicationPrivileges(target, roleName);

  return { roleName, databaseName, rolePassword, schemaVersion };
}

describe("createPostgresTenantDatabaseHealthChecker", () => {
  it("passes for a fully provisioned tenant database, using the tenant credential", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const { roleName, databaseName, rolePassword, schemaVersion } = await provisionTenantUpToPermissions(
      secretStore,
      tenantId,
    );
    const healthChecker = createPostgresTenantDatabaseHealthChecker();

    await expect(
      healthChecker.check({
        cluster: CLUSTER,
        databaseName,
        credential: { username: roleName, password: rolePassword },
        expectedSchemaVersion: schemaVersion,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails when the credential cannot authenticate", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const { roleName, databaseName, schemaVersion } = await provisionTenantUpToPermissions(
      secretStore,
      tenantId,
    );
    const healthChecker = createPostgresTenantDatabaseHealthChecker();

    await expect(
      healthChecker.check({
        cluster: CLUSTER,
        databaseName,
        credential: { username: roleName, password: "definitely-not-the-real-password" },
        expectedSchemaVersion: schemaVersion,
      }),
    ).rejects.toThrow(TenantDatabaseHealthCheckError);
  });

  it("fails when the given databaseName does not match reality", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const { roleName, rolePassword, schemaVersion } = await provisionTenantUpToPermissions(
      secretStore,
      tenantId,
    );
    const healthChecker = createPostgresTenantDatabaseHealthChecker();

    // `databaseName` drives both which database the check connects to *and* what it
    // compares `current_database()` against, so a caller-supplied name that doesn't match
    // reality never gets far enough to observe a mismatch on a live connection — it fails
    // to connect at all, exactly as it should for a database that doesn't exist. The
    // `current_database()` comparison itself is defense-in-depth against a future
    // implementation bug decoupling "what we connected to" from "what we compare against",
    // not something a caller can trigger through this port today.
    await expect(
      healthChecker.check({
        cluster: CLUSTER,
        databaseName: "a-completely-different-database-name",
        credential: { username: roleName, password: rolePassword },
        expectedSchemaVersion: schemaVersion,
      }),
    ).rejects.toThrow(TenantDatabaseHealthCheckError);
  });

  it("fails when the expected schemaVersion does not match what is actually applied", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const { roleName, databaseName, rolePassword, schemaVersion } = await provisionTenantUpToPermissions(
      secretStore,
      tenantId,
    );
    const healthChecker = createPostgresTenantDatabaseHealthChecker();

    await expect(
      healthChecker.check({
        cluster: CLUSTER,
        databaseName,
        credential: { username: roleName, password: rolePassword },
        expectedSchemaVersion: schemaVersion + 1,
      }),
    ).rejects.toThrow(TenantDatabaseHealthCheckError);
  });
});
