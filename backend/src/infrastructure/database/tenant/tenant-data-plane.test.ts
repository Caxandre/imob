import { randomUUID } from "node:crypto";

import { Client, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createClusterAdminCredentialResolver } from "../../../modules/provisioning/application/cluster-admin-credential-resolver.js";
import type { DatabaseCluster } from "../../../modules/provisioning/application/database-cluster-selector.js";
import { buildProvisioningResourceNames } from "../../../modules/provisioning/application/provisioning-resource-names.js";
import type { SecretStore } from "../../../modules/provisioning/application/secret-store.js";
import { createPostgresTenantDatabaseProvisioner } from "../../../modules/provisioning/infrastructure/postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "../../../modules/provisioning/infrastructure/postgres-tenant-role-provisioner.js";
import { createInMemorySecretStore } from "../../../modules/provisioning/test-support/in-memory-secret-store.js";
import { runTenantMigrations } from "./migrate.js";
import { grantTenantApplicationPrivileges } from "./permissions.js";
import type { TenantMigrationTarget } from "./migrate.js";

/**
 * Real `postgres-tenants` (Docker Compose), not a mock — migrations, GRANT/ALTER DEFAULT
 * PRIVILEGES, and DML/DDL enforcement must be proven against an actual server. Admin
 * credentials match the service's POSTGRES_USER/POSTGRES_PASSWORD; the admin secret itself
 * only ever lives in an in-memory SecretStore for this test run, never on disk.
 */
const ADMIN_SECRET_REFERENCE = "clusters/postgres-tenants-test-admin-tenant-data-plane";
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";

const CLUSTER: DatabaseCluster = {
  id: "00000000-0000-0000-0000-000000000003",
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

async function withClient<T>(
  config: { database: string; user: string; password: string },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: CLUSTER.host,
    port: CLUSTER.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
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

/**
 * Provisions a tenant's role + database (Prompts 013/014, already covered by their own
 * tests) up through CONNECT isolation, stopping exactly where this task's scope begins. The
 * migration target reuses the admin credential — never the tenant's own — for DDL/GRANT, per
 * ADR-003.
 */
async function provisionTenant(
  secretStore: SecretStore,
  tenantId: string,
): Promise<{ databaseName: string; roleName: string; rolePassword: string; target: TenantMigrationTarget }> {
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

  return { databaseName, roleName, rolePassword, target };
}

async function listPublicTables(databaseName: string): Promise<string[]> {
  return withClient({ database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD }, async (client) => {
    const result = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    return result.rows.map((row) => row.table_name);
  });
}

describe("Tenant Data Plane — migrations and permissions", () => {
  it("applies users/audit_logs/outbox_events to an empty tenant database", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const { databaseName, target } = await provisionTenant(secretStore, tenantId);

    const result = await runTenantMigrations(target);

    expect(result.schemaVersion).toBe(1);
    await expect(listPublicTables(databaseName)).resolves.toEqual(["audit_logs", "outbox_events", "users"]);
  });

  it("is idempotent: a second run applies nothing new and reports the same schemaVersion", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const { target } = await provisionTenant(secretStore, tenantId);

    const first = await runTenantMigrations(target);
    const second = await runTenantMigrations(target);

    expect(second).toEqual(first);
  });

  it("converges to one applied migration set when two callers run concurrently against the same database", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const { databaseName, target } = await provisionTenant(secretStore, tenantId);

    const results = await Promise.all([runTenantMigrations(target), runTenantMigrations(target)]);

    expect(results[0]).toEqual(results[1]);
    await expect(listPublicTables(databaseName)).resolves.toEqual(["audit_logs", "outbox_events", "users"]);
  });

  it("grants the tenant role DML but never DDL, and the role can actually operate the table", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const { roleName, rolePassword, target } = await provisionTenant(secretStore, tenantId);

    await runTenantMigrations(target);
    await grantTenantApplicationPrivileges(target, roleName);

    const roleConfig = { database: target.database, user: roleName, password: rolePassword };

    const insertedId = await withClient(roleConfig, async (client) => {
      const insertResult = await client.query<{ id: string }>(
        "INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id",
        [`${randomUUID()}@example.test`, "Ada Lovelace"],
      );
      return insertResult.rows[0]?.id;
    });
    expect(insertedId).toBeDefined();

    await withClient(roleConfig, async (client) => {
      const selectResult = await client.query("SELECT id FROM users WHERE id = $1", [insertedId]);
      expect(selectResult.rowCount).toBe(1);

      await client.query("UPDATE users SET name = $1 WHERE id = $2", ["Ada, Countess of Lovelace", insertedId]);
      const deleteResult = await client.query("DELETE FROM users WHERE id = $1", [insertedId]);
      expect(deleteResult.rowCount).toBe(1);
    });

    await expect(
      withClient(roleConfig, (client) => client.query("CREATE TABLE ddl_probe (id int)")),
    ).rejects.toThrow();

    await withAdminClient(async (client) => {
      const stillAbsent = await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ddl_probe'",
      );
      expect(stillAbsent.rowCount).toBe(0);
    });
  });

  it("A/B isolation: each tenant's data plane has its own schema and its own rows", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);

    const tenantA = freshTenantId();
    const tenantB = freshTenantId();
    const a = await provisionTenant(secretStore, tenantA);
    const b = await provisionTenant(secretStore, tenantB);

    await runTenantMigrations(a.target);
    await runTenantMigrations(b.target);
    await grantTenantApplicationPrivileges(a.target, a.roleName);
    await grantTenantApplicationPrivileges(b.target, b.roleName);

    const roleConfigA = { database: a.target.database, user: a.roleName, password: a.rolePassword };
    const roleConfigB = { database: b.target.database, user: b.roleName, password: b.rolePassword };
    const emailA = `${randomUUID()}@tenant-a.test`;
    const emailB = `${randomUUID()}@tenant-b.test`;

    await withClient(roleConfigA, (client) =>
      client.query("INSERT INTO users (email, name) VALUES ($1, $2)", [emailA, "Tenant A User"]),
    );
    await withClient(roleConfigB, (client) =>
      client.query("INSERT INTO users (email, name) VALUES ($1, $2)", [emailB, "Tenant B User"]),
    );

    const usersInA = await withClient(roleConfigA, (client) => client.query("SELECT email FROM users"));
    const usersInB = await withClient(roleConfigB, (client) => client.query("SELECT email FROM users"));

    expect(usersInA.rows.map((row: { email: string }) => row.email)).toEqual([emailA]);
    expect(usersInB.rows.map((row: { email: string }) => row.email)).toEqual([emailB]);
  });
});
