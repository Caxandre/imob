import { Client, escapeIdentifier } from "pg";

import type { ClusterAdminCredentialResolver } from "../application/cluster-admin-credential-resolver.js";
import type { DatabaseCluster } from "../application/database-cluster-selector.js";
import { buildProvisioningResourceNames } from "../application/provisioning-resource-names.js";
import {
  TenantApplicationRoleNotFoundError,
  TenantDatabaseProvisioningError,
} from "../application/tenant-database-provisioner.js";
import type { TenantDatabaseProvisioner } from "../application/tenant-database-provisioner.js";

/**
 * CREATE DATABASE/REVOKE/GRANT ON DATABASE are all cluster-level statements evaluated against
 * catalogs visible from any database on the cluster — none of them require connecting to the
 * tenant's own database (which, for CREATE DATABASE, does not even exist yet at the start of
 * this call). "postgres" is the maintenance database every PostgreSQL cluster is expected to
 * have by convention (see docker-compose's `postgres-tenants` service, which relies on
 * exactly this default) — same choice already made by the role provisioner (Prompt 013).
 */
const MAINTENANCE_DATABASE = "postgres";

/**
 * PostgreSQL SQLSTATE for "a database with this name already exists". Raised for the
 * straightforward pre-existence case.
 */
const DUPLICATE_DATABASE = "42P04";

/**
 * PostgreSQL SQLSTATE for a unique-constraint violation. Under a genuine concurrent race —
 * two CREATE DATABASE statements for the same name executing at once — PostgreSQL does not
 * always surface DUPLICATE_DATABASE; the loser can instead hit the underlying catalog's
 * unique index directly (constraint `pg_database_datname_index` on `pg_catalog.pg_database`),
 * observed empirically against the real `postgres-tenants` container. Both cases mean the
 * same thing from this function's perspective: the database now exists, created by someone
 * else.
 */
const UNIQUE_VIOLATION = "23505";
const DATNAME_UNIQUE_CONSTRAINT = "pg_database_datname_index";

/**
 * Defense in depth: `buildProvisioningResourceNames` already guarantees this shape, but both
 * identifiers are about to be interpolated into DDL text (PostgreSQL has no bind-parameter
 * support for identifiers), so this function refuses to proceed if that guarantee is ever
 * violated instead of trusting the caller silently.
 */
const SAFE_IDENTIFIER = /^[a-z0-9_]+$/;

function assertSafeIdentifier(identifier: string): void {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`Refusing to use unsafe identifier: "${identifier}"`);
  }
}

function isDuplicateDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (code === DUPLICATE_DATABASE) {
    return true;
  }
  return code === UNIQUE_VIOLATION && constraint === DATNAME_UNIQUE_CONSTRAINT;
}

async function roleExists(client: Client, roleName: string): Promise<boolean> {
  const result = await client.query<{ exists: 1 }>("SELECT 1 AS exists FROM pg_roles WHERE rolname = $1", [
    roleName,
  ]);
  return result.rowCount !== null && result.rowCount > 0;
}

async function databaseExists(client: Client, databaseName: string): Promise<boolean> {
  const result = await client.query<{ exists: 1 }>(
    "SELECT 1 AS exists FROM pg_database WHERE datname = $1",
    [databaseName],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Ownership is deliberately left at PostgreSQL's default (the connecting/executing role — the
 * cluster administrative credential): ADR-003 requires the database and its migration objects
 * to remain administratively owned, never OWNER = the tenant's application role, so no OWNER
 * clause is added here.
 *
 * Tolerates a real concurrent CREATE DATABASE for the same name (SQLSTATE 42P04,
 * duplicate_database): two callers can both observe "database does not exist" and both race to
 * create it — exactly one CREATE DATABASE wins, and the loser recognizes the database now
 * exists instead of failing the whole operation. Any other driver error is wrapped and
 * propagated, never silently swallowed as if it were the duplicate case.
 */
async function createDatabase(client: Client, databaseName: string): Promise<void> {
  const identifier = escapeIdentifier(databaseName);

  try {
    await client.query(`CREATE DATABASE ${identifier}`);
  } catch (error) {
    if (isDuplicateDatabaseError(error)) {
      return;
    }
    throw new TenantDatabaseProvisioningError("Failed to create tenant database", { cause: error });
  }
}

/**
 * PostgreSQL grants CONNECT on every database to PUBLIC by default — a separate database per
 * tenant is not, by itself, connection-level isolation. Revoking PUBLIC and granting CONNECT
 * only to the tenant's own application role is what actually prevents tenant A's role from
 * connecting to tenant B's database (ADR-003). Order matters for fail-closed behavior: REVOKE
 * always runs before GRANT, so a failure between the two leaves the database temporarily
 * unreachable by the tenant role rather than reachable by PUBLIC — and a retry only ever
 * reapplies both statements, never reopens PUBLIC as a compensation.
 */
async function reconcileConnectPolicy(client: Client, databaseName: string, roleName: string): Promise<void> {
  const databaseIdentifier = escapeIdentifier(databaseName);
  const roleIdentifier = escapeIdentifier(roleName);

  try {
    await client.query(`REVOKE CONNECT ON DATABASE ${databaseIdentifier} FROM PUBLIC`);
  } catch (error) {
    throw new TenantDatabaseProvisioningError("Failed to revoke public CONNECT on tenant database", {
      cause: error,
    });
  }

  try {
    await client.query(`GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${roleIdentifier}`);
  } catch (error) {
    throw new TenantDatabaseProvisioningError("Failed to grant tenant role CONNECT on tenant database", {
      cause: error,
    });
  }
}

/**
 * Real, PostgreSQL-backed `TenantDatabaseProvisioner`. Resolves the cluster's administrative
 * credential, opens a short-lived connection scoped to this single `ensureDatabase` call
 * (never a pool kept globally per tenant), and reconciles database existence + CONNECT
 * isolation — see `ensureDatabase` below.
 */
export function createPostgresTenantDatabaseProvisioner(deps: {
  clusterAdminCredentialResolver: ClusterAdminCredentialResolver;
}): TenantDatabaseProvisioner {
  return {
    async ensureDatabase(input: {
      tenantId: string;
      cluster: DatabaseCluster;
    }): Promise<{ databaseName: string }> {
      const { tenantId, cluster } = input;
      const { databaseName, roleName } = buildProvisioningResourceNames(tenantId);
      assertSafeIdentifier(databaseName);
      assertSafeIdentifier(roleName);

      const adminCredential = await deps.clusterAdminCredentialResolver.resolve(cluster.secretReference);

      const client = new Client({
        host: cluster.host,
        port: cluster.port,
        database: MAINTENANCE_DATABASE,
        user: adminCredential.username,
        password: adminCredential.password,
      });

      await client.connect();
      try {
        // Serializes concurrent ensureDatabase() calls for the same tenant on this cluster
        // (a PostgreSQL session-level advisory lock, released automatically if the session
        // ends unexpectedly). This is a stronger guarantee than tolerating individual
        // duplicate-resource errors: it also avoids a second, distinct real-server race,
        // observed empirically, where two concurrent REVOKE/GRANT statements against the same
        // database's catalog ACL row can raise "tuple concurrently updated" (SQLSTATE
        // XX000) — a transient conflict with no stable error code to safely pattern-match on.
        // The CREATE DATABASE duplicate-tolerance below is kept regardless, as defense in
        // depth for any caller that doesn't go through this lock.
        await client.query("SELECT pg_advisory_lock(hashtext($1))", [databaseName]);
        try {
          // The role prerequisite is checked before touching the database at all: this
          // component never creates the role itself (that belongs to TenantRoleProvisioner,
          // ADR-003), and must never create/reconcile a database meant for a role that
          // doesn't exist yet — for either a new or an already-existing database.
          if (!(await roleExists(client, roleName))) {
            throw new TenantApplicationRoleNotFoundError(roleName);
          }

          if (!(await databaseExists(client, databaseName))) {
            await createDatabase(client, databaseName);
          }

          await reconcileConnectPolicy(client, databaseName, roleName);

          return { databaseName };
        } finally {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [databaseName]);
        }
      } finally {
        await client.end();
      }
    },
  };
}
