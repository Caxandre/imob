import { randomUUID } from "node:crypto";

import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createClusterAdminCredentialResolver } from "../application/cluster-admin-credential-resolver.js";
import type { DatabaseCluster } from "../application/database-cluster-selector.js";
import { buildProvisioningResourceNames } from "../application/provisioning-resource-names.js";
import type { SecretStore } from "../application/secret-store.js";
import { TenantApplicationRoleNotFoundError } from "../application/tenant-database-provisioner.js";
import { createInMemorySecretStore } from "../test-support/in-memory-secret-store.js";
import { createPostgresTenantDatabaseProvisioner } from "./postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "./postgres-tenant-role-provisioner.js";

/**
 * Real `postgres-tenants` (Docker Compose), not a mock — CREATE DATABASE/REVOKE/GRANT and
 * CONNECT isolation must be proven against an actual server. Admin credentials match the
 * service's POSTGRES_USER/POSTGRES_PASSWORD; the admin secret itself only ever lives in an
 * in-memory SecretStore for this test run, never on disk.
 */
const ADMIN_SECRET_REFERENCE = "clusters/postgres-tenants-test-admin-db";
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";

const CLUSTER: DatabaseCluster = {
  id: "00000000-0000-0000-0000-000000000002",
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

async function countDatabase(databaseName: string): Promise<number> {
  return withAdminClient(async (client) => {
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    return result.rowCount ?? 0;
  });
}

/**
 * Proves a credential can actually open a connection to a specific tenant database, without
 * ever logging the password — the real assertion this task exists to make (ADR-003 CONNECT
 * isolation).
 */
async function canConnect(username: string, password: string, databaseName: string): Promise<boolean> {
  const client = new Client({
    host: CLUSTER.host,
    port: CLUSTER.port,
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

/**
 * Every authenticated PostgreSQL role is implicitly a member of PUBLIC, so a throwaway role
 * with no grants of its own is the real-server way to check whether PUBLIC can still connect
 * to a database — no ACL string parsing needed.
 */
async function canPublicConnect(databaseName: string): Promise<boolean> {
  const username = `probe_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();

  await withAdminClient(async (client) => {
    await client.query(`CREATE ROLE ${escapeIdentifier(username)} WITH LOGIN PASSWORD ${escapeLiteral(password)}`);
  });

  try {
    return await canConnect(username, password, databaseName);
  } finally {
    await withAdminClient(async (client) => {
      await client.query(`DROP ROLE IF EXISTS ${escapeIdentifier(username)}`);
    });
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
      // WITH (FORCE) also disconnects any lingering test connections (PostgreSQL 13+),
      // avoiding a "database is being accessed by other users" failure during cleanup.
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

/** Satisfies the role prerequisite this component itself deliberately refuses to create. */
async function ensureTenantRole(secretStore: SecretStore, tenantId: string): Promise<{ password: string }> {
  const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
  const roleProvisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
  const { secretReference } = await roleProvisioner.ensureRole({ tenantId, cluster: CLUSTER });
  return (await secretStore.get(secretReference)) as { password: string };
}

describe("createPostgresTenantDatabaseProvisioner", () => {
  it("creates the tenant database when the application role already exists", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    await ensureTenantRole(secretStore, tenantId);
    const expected = buildProvisioningResourceNames(tenantId);
    const provisioner = createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver });

    const result = await provisioner.ensureDatabase({ tenantId, cluster: CLUSTER });

    expect(result).toEqual({ databaseName: expected.databaseName });
    await expect(countDatabase(expected.databaseName)).resolves.toBe(1);
  });

  it("is idempotent: a second call results in exactly one database, same name, no error", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    await ensureTenantRole(secretStore, tenantId);
    const expected = buildProvisioningResourceNames(tenantId);
    const provisioner = createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver });

    const first = await provisioner.ensureDatabase({ tenantId, cluster: CLUSTER });
    const second = await provisioner.ensureDatabase({ tenantId, cluster: CLUSTER });

    expect(second).toEqual(first);
    await expect(countDatabase(expected.databaseName)).resolves.toBe(1);
  });

  it("refuses to create the database when the application role is missing", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    // Deliberately never provisioning the role — this is the case under test.
    const expected = buildProvisioningResourceNames(tenantId);
    const provisioner = createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver });

    await expect(provisioner.ensureDatabase({ tenantId, cluster: CLUSTER })).rejects.toThrow(
      TenantApplicationRoleNotFoundError,
    );

    await expect(countDatabase(expected.databaseName)).resolves.toBe(0);
  });

  it("tolerates a real concurrent CREATE DATABASE race, converging on exactly one database", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    await ensureTenantRole(secretStore, tenantId);
    const expected = buildProvisioningResourceNames(tenantId);
    const provisioner = createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver });

    // Two genuinely concurrent calls for the same never-before-seen tenantId: both observe
    // "database does not exist" and both attempt CREATE DATABASE — PostgreSQL allows only one
    // to succeed, giving a real (not simulated) duplicate_database error for the other, which
    // the provisioner must tolerate rather than fail on.
    const results = await Promise.allSettled([
      provisioner.ensureDatabase({ tenantId, cluster: CLUSTER }),
      provisioner.ensureDatabase({ tenantId, cluster: CLUSTER }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      expect((result as PromiseFulfilledResult<{ databaseName: string }>).value).toEqual({
        databaseName: expected.databaseName,
      });
    }
    await expect(countDatabase(expected.databaseName)).resolves.toBe(1);
  });

  it("reconciles CONNECT isolation on an already-existing database that still grants PUBLIC", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const roleSecret = await ensureTenantRole(secretStore, tenantId);
    const expected = buildProvisioningResourceNames(tenantId);

    // Simulates a database that already exists but was never reconciled by this component —
    // a fresh CREATE DATABASE still grants CONNECT to PUBLIC by PostgreSQL's default.
    await withAdminClient(async (client) => {
      await client.query(`CREATE DATABASE ${escapeIdentifier(expected.databaseName)}`);
    });
    await expect(canPublicConnect(expected.databaseName)).resolves.toBe(true);

    const provisioner = createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver });
    await provisioner.ensureDatabase({ tenantId, cluster: CLUSTER });

    await expect(canPublicConnect(expected.databaseName)).resolves.toBe(false);
    await expect(canConnect(expected.roleName, roleSecret.password, expected.databaseName)).resolves.toBe(true);
  });

  it("A/B isolation: each tenant's role can connect only to its own database (real PostgreSQL)", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const provisioner = createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver });

    const tenantA = freshTenantId();
    const tenantB = freshTenantId();
    const secretA = await ensureTenantRole(secretStore, tenantA);
    const secretB = await ensureTenantRole(secretStore, tenantB);
    const namesA = buildProvisioningResourceNames(tenantA);
    const namesB = buildProvisioningResourceNames(tenantB);

    await provisioner.ensureDatabase({ tenantId: tenantA, cluster: CLUSTER });
    await provisioner.ensureDatabase({ tenantId: tenantB, cluster: CLUSTER });

    await expect(canConnect(namesA.roleName, secretA.password, namesA.databaseName)).resolves.toBe(true);
    await expect(canConnect(namesB.roleName, secretB.password, namesB.databaseName)).resolves.toBe(true);
    await expect(canConnect(namesA.roleName, secretA.password, namesB.databaseName)).resolves.toBe(false);
    await expect(canConnect(namesB.roleName, secretB.password, namesA.databaseName)).resolves.toBe(false);
  });
});
