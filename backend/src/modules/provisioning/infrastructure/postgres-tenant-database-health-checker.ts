import { Client } from "pg";

import {
  TenantDatabaseHealthCheckError,
} from "../application/tenant-database-health-checker.js";
import type { TenantDatabaseHealthChecker } from "../application/tenant-database-health-checker.js";

/**
 * Real, PostgreSQL-backed `TenantDatabaseHealthChecker`. Opens a short-lived connection using
 * the *tenant application credential* (never admin) — connecting successfully is itself part
 * of what's being proven, so the connection attempt and every check below share the same
 * try/finally scope.
 */
export function createPostgresTenantDatabaseHealthChecker(): TenantDatabaseHealthChecker {
  return {
    async check(input): Promise<void> {
      const { cluster, databaseName, credential, expectedSchemaVersion } = input;

      const client = new Client({
        host: cluster.host,
        port: cluster.port,
        database: databaseName,
        user: credential.username,
        password: credential.password,
        connectionTimeoutMillis: 5000,
      });

      try {
        await client.connect();
      } catch (error) {
        throw new TenantDatabaseHealthCheckError(
          "Failed to authenticate as the tenant application role",
          { cause: error },
        );
      }

      try {
        const databaseResult = await client.query<{ current_database: string }>(
          "SELECT current_database()",
        );
        const actualDatabase = databaseResult.rows[0]?.current_database;
        if (actualDatabase !== databaseName) {
          throw new TenantDatabaseHealthCheckError(
            `Connected to an unexpected database (expected "${databaseName}", got "${actualDatabase}")`,
          );
        }

        const probeResult = await client.query<{ "?column?": number }>("SELECT 1");
        if (probeResult.rowCount !== 1) {
          throw new TenantDatabaseHealthCheckError("SELECT 1 probe returned an unexpected result");
        }

        // Same table `runTenantMigrations()` itself reads to compute schemaVersion
        // (drizzle-orm's own migration ledger) — read here through the tenant's own
        // credential, not a second administrative connection, so this check proves the
        // application can actually observe the schema state it will rely on.
        const migrationsResult = await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM drizzle.__drizzle_migrations",
        );
        const actualSchemaVersion = Number(migrationsResult.rows[0]?.count ?? 0);
        if (actualSchemaVersion !== expectedSchemaVersion) {
          throw new TenantDatabaseHealthCheckError(
            `Unexpected schema version (expected ${expectedSchemaVersion}, found ${actualSchemaVersion})`,
          );
        }
      } catch (error) {
        if (error instanceof TenantDatabaseHealthCheckError) {
          throw error;
        }
        throw new TenantDatabaseHealthCheckError("Tenant database health check failed", { cause: error });
      } finally {
        await client.end();
      }
    },
  };
}
