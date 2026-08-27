import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { Client, escapeIdentifier } from "pg";
import pino from "pino";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { env } from "../config/env.js";
import { controlPlaneDb, controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { databaseClusters, provisioningJobs, tenantDatabases, tenants } from "../infrastructure/database/control-plane/schema.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import { buildProvisioningResourceNames } from "../modules/provisioning/application/provisioning-resource-names.js";
import { createInMemorySecretStore } from "../modules/provisioning/test-support/in-memory-secret-store.js";
import { createPgTenantDatabaseConnectionManager } from "../modules/tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";
import { createDrizzleTenantRepository } from "../modules/tenants/infrastructure/drizzle-tenant-repository.js";
import { createProvisioningWorkerRuntime } from "./provisioning-worker-runtime.js";

/**
 * Proves the exact technical claim `dev-full.ts` (`pnpm dev:full`) depends on — before the
 * Properties module was even built (this task, section 14): a `TenantDatabaseConnectionManager`
 * can resolve and use a tenant credential the provisioning worker runtime wrote, *if and only
 * if* both were built from the same `SecretStore` instance. The second test proves the inverse
 * — the exact gap `server.ts`/`provisioning-worker.ts` have as genuinely separate processes —
 * so this file documents both halves of the claim, not just the happy path.
 *
 * Uses a real BullMQ `Worker`/Redis connection (via `createProvisioningWorkerRuntime`) but
 * never goes through the queue — `databaseProvisioner.provision()` is called directly, exactly
 * like the recovery scenario in `../modules/provisioning/e2e-provisioning.test.ts` does, since
 * this test is about SecretStore sharing, not queue delivery (already covered elsewhere).
 */
// createProvisioningWorkerRuntime() always selects env.TENANT_DATABASE_DEFAULT_CLUSTER
// internally (it composes the real DatabaseClusterSelector, same as provisioning-worker.ts)
// — this test's cluster row must be named exactly that, not an arbitrary test-local name.
const CLUSTER_NAME = env.TENANT_DATABASE_DEFAULT_CLUSTER;
const ADMIN_SECRET_REFERENCE = `clusters/dev-full-composition-test`;
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";
const TENANTS_HOST = "localhost";
const TENANTS_PORT = 5433;

const silentLogger = pino({ level: "silent" });

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

async function setupClusterAndTenant(secretStore: ReturnType<typeof createInMemorySecretStore>) {
  await controlPlaneDb.insert(databaseClusters).values({
    name: CLUSTER_NAME,
    status: "ACTIVE",
    provider: "local",
    region: "local",
    host: TENANTS_HOST,
    port: TENANTS_PORT,
    secretReference: ADMIN_SECRET_REFERENCE,
  });
  await secretStore.put(ADMIN_SECRET_REFERENCE, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  const tenantRepository = createDrizzleTenantRepository(controlPlaneDb);
  const tenant = await tenantRepository.createWithProvisioningIntent({
    name: "Dev Full Composition",
    slug: `dev-full-${randomUUID()}`,
  });
  trackTenantResources(tenant.id);

  return tenant;
}

describe("createProvisioningWorkerRuntime — SecretStore sharing (dev-full composition)", () => {
  it("lets a TenantDatabaseConnectionManager built from the SAME SecretStore resolve and connect using the credential the worker runtime wrote", async () => {
    const sharedSecretStore = createInMemorySecretStore();
    const tenant = await setupClusterAndTenant(sharedSecretStore);
    const workerRuntime = createProvisioningWorkerRuntime(sharedSecretStore, silentLogger);

    try {
      const result = await workerRuntime.databaseProvisioner.provision({
        provisioningJobId: randomUUID(),
        tenantId: tenant.id,
      });

      // The "HTTP API side" of dev-full.ts — built from the exact same SecretStore instance.
      const connectionManager = createPgTenantDatabaseConnectionManager({
        credentialResolver: createTenantDatabaseCredentialResolver(sharedSecretStore),
      });

      try {
        const currentDatabase = await connectionManager.withTenantDatabase(
          {
            tenantId: tenant.id,
            clusterId: result.clusterId,
            host: TENANTS_HOST,
            port: TENANTS_PORT,
            databaseName: result.databaseName,
            secretReference: result.secretReference,
            schemaVersion: result.schemaVersion,
          },
          async (db) => {
            const rows = await db.execute<{ current_database: string }>(sql`select current_database()`);
            return rows.rows[0]?.current_database;
          },
        );

        expect(currentDatabase).toBe(result.databaseName);
      } finally {
        await connectionManager.close();
      }
    } finally {
      await workerRuntime.shutdown();
    }
  });

  it("proves the gap: a connection manager built from a DIFFERENT SecretStore instance cannot resolve the same tenant's credential (never falls back to the admin credential)", async () => {
    const workerSecretStore = createInMemorySecretStore();
    const tenant = await setupClusterAndTenant(workerSecretStore);
    const workerRuntime = createProvisioningWorkerRuntime(workerSecretStore, silentLogger);

    try {
      const result = await workerRuntime.databaseProvisioner.provision({
        provisioningJobId: randomUUID(),
        tenantId: tenant.id,
      });

      // Simulates server.ts run as a genuinely separate process: its own, empty SecretStore.
      const apiOnlySecretStore = createInMemorySecretStore();
      const connectionManager = createPgTenantDatabaseConnectionManager({
        credentialResolver: createTenantDatabaseCredentialResolver(apiOnlySecretStore),
      });

      try {
        await expect(
          connectionManager.withTenantDatabase(
            {
              tenantId: tenant.id,
              clusterId: result.clusterId,
              host: TENANTS_HOST,
              port: TENANTS_PORT,
              databaseName: result.databaseName,
              secretReference: result.secretReference,
              schemaVersion: result.schemaVersion,
            },
            async (db) => {
              await db.execute(sql`select 1`);
            },
          ),
        ).rejects.toThrow(/no tenant database secret found/i);
      } finally {
        await connectionManager.close();
      }
    } finally {
      await workerRuntime.shutdown();
    }
  });
});
