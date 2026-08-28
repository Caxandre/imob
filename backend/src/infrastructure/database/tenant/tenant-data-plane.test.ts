import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createClusterAdminCredentialResolver } from "../../../modules/provisioning/application/cluster-admin-credential-resolver.js";
import type { DatabaseCluster } from "../../../modules/provisioning/application/database-cluster-selector.js";
import { buildProvisioningResourceNames } from "../../../modules/provisioning/application/provisioning-resource-names.js";
import type { SecretStore } from "../../../modules/provisioning/application/secret-store.js";
import { createPostgresTenantDatabaseProvisioner } from "../../../modules/provisioning/infrastructure/postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "../../../modules/provisioning/infrastructure/postgres-tenant-role-provisioner.js";
import { createInMemorySecretStore } from "../../../modules/provisioning/test-support/in-memory-secret-store.js";
import { runTenantMigrations } from "./migrate.js";
import { TENANT_MIGRATIONS_FOLDER } from "./migrations-folder.js";
import { grantTenantApplicationPrivileges } from "./permissions.js";
import type { TenantMigrationTarget } from "./migrate.js";

interface MigrationJournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/**
 * Builds a temporary migrations folder containing only the migrations strictly before `tag`
 * (Prompt 030, section 6/58) — used exactly once, to prove the real guarantee a `NOT NULL
 * DEFAULT` column addition gives in PostgreSQL: a row inserted under the *old* schema (before
 * `processing_status` existed) is still present, unaffected in every other column, once the
 * migration that adds it actually runs. `migrate()` only needs `.sql` files plus a matching
 * `meta/_journal.json` — the `meta/*_snapshot.json` files are a `drizzle-kit generate`-time
 * concern, never read by the migration runner itself.
 */
function buildMigrationsFolderBefore(tag: string): string {
  const journalPath = join(TENANT_MIGRATIONS_FOLDER, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    version: string;
    dialect: string;
    entries: MigrationJournalEntry[];
  };
  const cutoffIndex = journal.entries.findIndex((entry) => entry.tag === tag);
  if (cutoffIndex === -1) {
    throw new Error(`migration tag "${tag}" not found in journal`);
  }
  const entries = journal.entries.slice(0, cutoffIndex);

  const dir = mkdtempSync(join(tmpdir(), "imob-tenant-migrations-"));
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    const sqlFileName = `${entry.tag}.sql`;
    writeFileSync(join(dir, sqlFileName), readFileSync(join(TENANT_MIGRATIONS_FOLDER, sqlFileName)));
  }
  return dir;
}

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
  it("applies users/audit_logs/outbox_events/properties to an empty tenant database", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const { databaseName, target } = await provisionTenant(secretStore, tenantId);

    const result = await runTenantMigrations(target);

    expect(result.schemaVersion).toBe(6);
    await expect(listPublicTables(databaseName)).resolves.toEqual([
      "audit_logs",
      "outbox_events",
      "properties",
      "property_media",
      "property_media_variants",
      "users",
    ]);
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
    await expect(listPublicTables(databaseName)).resolves.toEqual([
      "audit_logs",
      "outbox_events",
      "properties",
      "property_media",
      "property_media_variants",
      "users",
    ]);
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

  it("backfills property_media rows that existed before processing_status to READY (Prompt 030, section 6)", async () => {
    const { secretStore } = buildDeps();
    await seedAdminSecret(secretStore);
    const tenantId = freshTenantId();
    const { target } = await provisionTenant(secretStore, tenantId);

    // Simulate a tenant database migrated up through 0004 (property_media exists, but with no
    // processing_status column yet) — exactly the real-world state of any tenant provisioned
    // before this task.
    const preMigrationFolder = buildMigrationsFolderBefore("0005_add_media_processing_status_and_variants");
    try {
      const pool = new Pool(target);
      try {
        await migrate(drizzle(pool), { migrationsFolder: preMigrationFolder });
      } finally {
        await pool.end();
      }
    } finally {
      rmSync(preMigrationFolder, { recursive: true, force: true });
    }

    const propertyId = randomUUID();
    const mediaId = randomUUID();
    const adminConfig = { database: target.database, user: ADMIN_USERNAME, password: ADMIN_PASSWORD };
    await withClient(adminConfig, async (client) => {
      await client.query(
        `INSERT INTO properties (id, title, property_type, transaction_type, status, price)
         VALUES ($1, 'Existing property', 'APARTMENT', 'SALE', 'ACTIVE', 100000.00)`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO property_media (id, property_id, object_key, public_url, mime_type, size_bytes, position)
         VALUES ($1, $2, $3, 'https://example.test/existing.jpg', 'image/jpeg', 100, 0)`,
        [mediaId, propertyId, `tenants/existing-tenant/properties/${propertyId}/${mediaId}.jpg`],
      );
    });

    // The migration this task adds (0005) now runs against a database that already has a
    // property_media row from before processing_status existed.
    await runTenantMigrations(target);

    await withClient(adminConfig, async (client) => {
      const result = await client.query<{ processing_status: string }>(
        "SELECT processing_status FROM property_media WHERE id = $1",
        [mediaId],
      );
      // READY here means "original operational under the previous model," never "variants
      // exist" — no variant was generated by this migration (this task, section 6).
      expect(result.rows[0]?.processing_status).toBe("READY");
    });
  });
});
