import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { TENANT_MIGRATIONS_FOLDER } from "./migrations-folder.js";

/**
 * Connection details for the target tenant database. Always the cluster
 * administrative/migration credential (ADR-003) — DDL is never a tenant application role
 * privilege. The caller resolves and supplies this; this module never resolves a tenant or a
 * cluster itself.
 */
export interface TenantMigrationTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface TenantMigrationResult {
  schemaVersion: number;
}

/**
 * A fixed, arbitrary key for the session-level advisory lock this function takes on its
 * target database. Serializes concurrent `runTenantMigrations()` calls against the *same*
 * database — since the caller always connects directly to that one database, a shared
 * constant key is enough to disambiguate from any unrelated advisory-lock use in this
 * database. It never needs to encode the database name itself (contrast
 * postgres-tenant-database-provisioner.ts, Prompt 014, which shares one "postgres"
 * maintenance connection across every tenant and therefore does hash the target name into
 * its key).
 */
const MIGRATION_LOCK_KEY = "imob:tenant-migrations";

/**
 * Applies every pending Tenant Data Plane migration to the given already-provisioned tenant
 * database, and reports the schema version now applied.
 *
 * drizzle-orm's own `migrate()` already only (re-)applies migrations newer than the last one
 * recorded in `drizzle.__drizzle_migrations`, inside a single transaction — safe to call
 * repeatedly, and safe against a crash mid-migration (the transaction never commits
 * partially). It is not, on its own, safe against two callers targeting the same database at
 * the same time: the read of the last-applied migration happens *before* that transaction, so
 * two concurrent callers can both observe "nothing applied yet" and both attempt the same
 * `CREATE TABLE` — the same class of real catalog race already found and handled in
 * `postgres-tenant-database-provisioner.ts` (Prompt 014). A session-level advisory lock closes
 * that gap without inventing a new locking primitive. `max: 1` on the pool guarantees the
 * lock, the migration itself, and the unlock all run on the exact same physical connection —
 * required for `pg_advisory_unlock` to actually release what `pg_advisory_lock` acquired.
 */
export async function runTenantMigrations(target: TenantMigrationTarget): Promise<TenantMigrationResult> {
  const pool = new Pool({ ...target, max: 1 });
  try {
    await pool.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    try {
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: TENANT_MIGRATIONS_FOLDER });
      return { schemaVersion: await readSchemaVersion(pool) };
    } finally {
      await pool.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await pool.end();
  }
}

/**
 * The number of migrations drizzle itself has recorded as applied — derived directly from its
 * own tracking table rather than a parallel, manually-maintained counter — is used as
 * `schemaVersion`, matching `tenant_databases.schema_version integer` (never altered by this
 * task). Increases by exactly one each time a new Tenant Data Plane migration file is added
 * and applied; stable across repeat calls once nothing new is pending.
 */
async function readSchemaVersion(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM drizzle.__drizzle_migrations",
  );
  return Number(result.rows[0]?.count ?? 0);
}
