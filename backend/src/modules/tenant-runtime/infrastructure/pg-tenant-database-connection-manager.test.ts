import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createTenantDatabaseCredentialResolver } from "../../provisioning/application/tenant-database-credential-resolver.js";
import { createInMemorySecretStore } from "../../provisioning/test-support/in-memory-secret-store.js";
import type { TenantDatabaseTarget } from "../application/tenant-database-resolver.js";
import { createPgTenantDatabaseConnectionManager } from "./pg-tenant-database-connection-manager.js";

/**
 * Real `postgres-tenants` (Docker Compose), not a mock. Fixtures here are deliberately raw SQL
 * (a role + database created directly, no tenant migrations applied) rather than going through
 * the full provisioning pipeline: this file only exercises the connection manager itself —
 * pooling, lifecycle, credential handling — never Control Plane state, which is
 * `drizzle-tenant-database-resolver.test.ts`'s job. Typed Drizzle queries against the real
 * Tenant Data Plane schema are proven end to end in `../e2e-tenant-database-runtime.test.ts`,
 * where migrations have actually run.
 */
const CLUSTER_HOST = "localhost";
const CLUSTER_PORT = 5433;
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: CLUSTER_HOST,
    port: CLUSTER_PORT,
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

interface Fixture {
  target: TenantDatabaseTarget;
  roleName: string;
  databaseName: string;
  password: string;
}

const createdFixtures: Fixture[] = [];

async function createTenantFixture(): Promise<Fixture> {
  const suffix = randomUUID().replaceAll("-", "");
  const roleName = `runtime_test_${suffix}`;
  const databaseName = `runtime_test_${suffix}`;
  const password = randomUUID();
  const secretReference = `tenant-databases/runtime-test-${suffix}`;

  await withAdminClient(async (client) => {
    await client.query(
      `CREATE ROLE ${escapeIdentifier(roleName)} WITH LOGIN PASSWORD ${escapeLiteral(password)}`,
    );
    await client.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);
    await client.query(`REVOKE CONNECT ON DATABASE ${escapeIdentifier(databaseName)} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT ON DATABASE ${escapeIdentifier(databaseName)} TO ${escapeIdentifier(roleName)}`,
    );
  });

  const fixture: Fixture = {
    roleName,
    databaseName,
    password,
    target: {
      tenantId: randomUUID(),
      clusterId: randomUUID(),
      host: CLUSTER_HOST,
      port: CLUSTER_PORT,
      databaseName,
      secretReference,
      schemaVersion: 0,
    },
  };
  createdFixtures.push(fixture);
  return fixture;
}

function seededSecretStore(...fixtures: Fixture[]) {
  const secretStore = createInMemorySecretStore();
  for (const fixture of fixtures) {
    void secretStore.put(fixture.target.secretReference, {
      username: fixture.roleName,
      password: fixture.password,
    });
  }
  return secretStore;
}

afterEach(async () => {
  const fixtures = createdFixtures.splice(0, createdFixtures.length);
  await withAdminClient(async (client) => {
    for (const fixture of fixtures) {
      await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(fixture.databaseName)} WITH (FORCE)`);
      await client.query(`DROP ROLE IF EXISTS ${escapeIdentifier(fixture.roleName)}`);
    }
  });
});

describe("createPgTenantDatabaseConnectionManager", () => {
  it("opens a real connection authenticated as the tenant application role and runs a query", async () => {
    const fixture = await createTenantFixture();
    const manager = createPgTenantDatabaseConnectionManager({
      credentialResolver: createTenantDatabaseCredentialResolver(seededSecretStore(fixture)),
    });

    try {
      const result = await manager.withTenantDatabase(fixture.target, async (db) => {
        const rows = await db.execute<{ current_database: string }>(sql`select current_database()`);
        return rows.rows[0]?.current_database;
      });

      expect(result).toBe(fixture.databaseName);
    } finally {
      await manager.close();
    }
  });

  it("reuses the same pool across consecutive calls for the same tenant", async () => {
    const fixture = await createTenantFixture();
    let resolveCalls = 0;
    const credentialResolver = createTenantDatabaseCredentialResolver(seededSecretStore(fixture));
    const manager = createPgTenantDatabaseConnectionManager({
      credentialResolver: {
        resolve: async (ref) => {
          resolveCalls += 1;
          return credentialResolver.resolve(ref);
        },
      },
    });

    try {
      await manager.withTenantDatabase(fixture.target, async (db) => {
        await db.execute(sql`select 1`);
      });
      await manager.withTenantDatabase(fixture.target, async (db) => {
        await db.execute(sql`select 1`);
      });

      // A credential is only ever resolved when a new pool is created — reused pools never
      // re-resolve the secret on every call.
      expect(resolveCalls).toBe(1);
    } finally {
      await manager.close();
    }
  });

  it("invalidate() closes the cached pool — the next call opens a fresh one", async () => {
    const fixture = await createTenantFixture();
    let resolveCalls = 0;
    const credentialResolver = createTenantDatabaseCredentialResolver(seededSecretStore(fixture));
    const manager = createPgTenantDatabaseConnectionManager({
      credentialResolver: {
        resolve: async (ref) => {
          resolveCalls += 1;
          return credentialResolver.resolve(ref);
        },
      },
    });

    try {
      await manager.withTenantDatabase(fixture.target, async (db) => {
        await db.execute(sql`select 1`);
      });
      await manager.invalidate(fixture.target.tenantId);
      await manager.withTenantDatabase(fixture.target, async (db) => {
        await db.execute(sql`select 1`);
      });

      expect(resolveCalls).toBe(2);
    } finally {
      await manager.close();
    }
  });

  it("close() ends every cached pool without leaving handles open", async () => {
    const fixtureA = await createTenantFixture();
    const fixtureB = await createTenantFixture();
    const manager = createPgTenantDatabaseConnectionManager({
      credentialResolver: createTenantDatabaseCredentialResolver(seededSecretStore(fixtureA, fixtureB)),
    });

    await manager.withTenantDatabase(fixtureA.target, async (db) => {
      await db.execute(sql`select 1`);
    });
    await manager.withTenantDatabase(fixtureB.target, async (db) => {
      await db.execute(sql`select 1`);
    });

    await expect(manager.close()).resolves.toBeUndefined();
  });

  it("never attempts a connection when the secret is missing — the credential resolver's error propagates", async () => {
    const fixture = await createTenantFixture();
    const manager = createPgTenantDatabaseConnectionManager({
      credentialResolver: createTenantDatabaseCredentialResolver(createInMemorySecretStore()),
    });

    try {
      await expect(
        manager.withTenantDatabase(fixture.target, async (db) => {
          await db.execute(sql`select 1`);
          throw new Error("should never run — the missing secret must short-circuit first");
        }),
      ).rejects.toThrow(/no tenant database secret found/i);
    } finally {
      await manager.close();
    }
  });

  it("evicts the least-recently-used pool once maxPools is reached", async () => {
    const fixtureA = await createTenantFixture();
    const fixtureB = await createTenantFixture();
    let resolveCalls = 0;
    const credentialResolver = createTenantDatabaseCredentialResolver(seededSecretStore(fixtureA, fixtureB));
    const manager = createPgTenantDatabaseConnectionManager({
      credentialResolver: {
        resolve: async (ref) => {
          resolveCalls += 1;
          return credentialResolver.resolve(ref);
        },
      },
      maxPools: 1,
    });

    try {
      await manager.withTenantDatabase(fixtureA.target, async (db) => {
        await db.execute(sql`select 1`);
      });
      // Opening tenant B's pool must evict tenant A's (maxPools: 1) — a subsequent call for A
      // has to resolve its credential and open a fresh pool again.
      await manager.withTenantDatabase(fixtureB.target, async (db) => {
        await db.execute(sql`select 1`);
      });
      await manager.withTenantDatabase(fixtureA.target, async (db) => {
        await db.execute(sql`select 1`);
      });

      expect(resolveCalls).toBe(3);
    } finally {
      await manager.close();
    }
  });

  it("security: never uses a cluster admin credential — connecting succeeds with only the tenant secret ever stored", async () => {
    const fixture = await createTenantFixture();
    // Deliberately the ONLY secret ever put into this store — no "clusters/..." admin
    // reference exists here at all. If the connection manager reached for anything but the
    // tenant credential resolved from target.secretReference, this would fail.
    const manager = createPgTenantDatabaseConnectionManager({
      credentialResolver: createTenantDatabaseCredentialResolver(seededSecretStore(fixture)),
    });

    try {
      await expect(
        manager.withTenantDatabase(fixture.target, async (db) => {
          const rows = await db.execute<{ current_user: string }>(sql`select current_user`);
          return rows.rows[0]?.current_user;
        }),
      ).resolves.toBe(fixture.roleName);
    } finally {
      await manager.close();
    }
  });
});
