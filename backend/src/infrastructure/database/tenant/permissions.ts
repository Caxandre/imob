import { Client, escapeIdentifier } from "pg";

/**
 * Connection details for the target tenant database. Always the cluster
 * administrative/migration credential (ADR-003), the same one that ran the migrations these
 * privileges are granted against — DDL, GRANT and ALTER DEFAULT PRIVILEGES are never a tenant
 * application role privilege.
 */
export interface TenantSchemaPermissionsTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

const SAFE_IDENTIFIER = /^[a-z0-9_]+$/;

function assertSafeIdentifier(identifier: string): void {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`Refusing to use unsafe identifier: "${identifier}"`);
  }
}

/**
 * Grants the tenant application role exactly the operational privileges ADR-003 allows on the
 * `public` schema — USAGE, and DML on existing *and future* tables/sequences — never DDL
 * (`CREATE`/`ALTER`/`DROP`/`TRUNCATE`). Intended to run once per migration/reconciliation
 * cycle, right after `runTenantMigrations()` — every statement here is idempotent (`GRANT`
 * and `ALTER DEFAULT PRIVILEGES` are re-appliable with no error and no effect when nothing
 * changed), so calling this again later, e.g. after a new migration adds a table, is always
 * safe.
 *
 * Connects directly to the tenant's own database — unlike the CONNECT-isolation step in
 * `postgres-tenant-database-provisioner.ts` (Prompt 014), which acts on cluster-wide catalogs
 * from the "postgres" maintenance database, GRANT/ALTER DEFAULT PRIVILEGES on schema/table/
 * sequence objects are scoped to the database that actually owns those objects.
 */
export async function grantTenantApplicationPrivileges(
  target: TenantSchemaPermissionsTarget,
  roleName: string,
): Promise<void> {
  assertSafeIdentifier(roleName);
  const role = escapeIdentifier(roleName);

  const client = new Client(target);
  await client.connect();
  try {
    // Fail-closed, not just default-reliant (ADR-003, section "Schema public"): PostgreSQL
    // 15+ already stops granting CREATE on `public` to PUBLIC by default, but this
    // database's exact defaults must never be assumed. Every authenticated role is
    // implicitly a PUBLIC member, so this alone keeps the tenant role — and everyone else —
    // from creating arbitrary objects in the schema, even if that default were ever
    // overridden.
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");

    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);

    // Objects that already exist (created by migrations that already ran).
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);

    // Objects created by future migrations (ADR-003). `FOR ROLE` is deliberately omitted:
    // PostgreSQL defaults it to the current role when absent, which is exactly the
    // administrative/migration credential this function is already connected as — the same
    // one that will run every future migration.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
  } finally {
    await client.end();
  }
}
