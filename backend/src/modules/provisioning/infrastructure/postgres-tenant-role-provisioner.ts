import { Client, escapeIdentifier, escapeLiteral } from "pg";

import type { ClusterAdminCredentialResolver } from "../application/cluster-admin-credential-resolver.js";
import type { DatabaseCluster } from "../application/database-cluster-selector.js";
import { tenantDatabaseCredentialSchema } from "../application/database-credential.js";
import type { TenantDatabaseCredential } from "../application/database-credential.js";
import { buildProvisioningResourceNames } from "../application/provisioning-resource-names.js";
import type { SecretStore } from "../application/secret-store.js";
import { createTenantDatabaseCredential } from "../application/tenant-database-credential-generator.js";
import {
  InvalidTenantSecretError,
  TenantRoleProvisioningError,
} from "../application/tenant-role-provisioner.js";
import type { TenantRoleProvisioner } from "../application/tenant-role-provisioner.js";

/**
 * CREATE ROLE/ALTER ROLE are cluster-wide statements — not scoped to any particular
 * database — so the administrative connection just needs a database to attach to, not a
 * specific one. "postgres" is the maintenance database every PostgreSQL cluster is expected
 * to have by convention (see docker-compose's `postgres-tenants` service, which relies on
 * exactly this default).
 */
const MAINTENANCE_DATABASE = "postgres";

/**
 * Defense in depth: `buildProvisioningResourceNames` already guarantees this shape, but role
 * identifiers are about to be interpolated into DDL text (PostgreSQL has no bind-parameter
 * support for identifiers), so this function refuses to proceed if that guarantee is ever
 * violated instead of trusting the caller silently.
 */
const SAFE_ROLE_NAME = /^[a-z0-9_]+$/;

function assertSafeRoleName(roleName: string): void {
  if (!SAFE_ROLE_NAME.test(roleName)) {
    throw new Error(`Refusing to use unsafe role identifier: "${roleName}"`);
  }
}

async function roleExists(client: Client, roleName: string): Promise<boolean> {
  const result = await client.query<{ exists: 1 }>("SELECT 1 AS exists FROM pg_roles WHERE rolname = $1", [
    roleName,
  ]);
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * PostgreSQL's grammar does not accept a bind parameter in place of the `PASSWORD` literal
 * of CREATE ROLE/ALTER ROLE (utility statements, unlike SELECT/INSERT/UPDATE/DELETE, do not
 * support parameterized values in that position) — the password has to be embedded as SQL
 * text. `pg.escapeLiteral`/`pg.escapeIdentifier` are the driver's own safe-quoting utilities
 * (double any embedded quote character and wrap), used here instead of hand-rolled escaping.
 * In practice the password is always our own `crypto.randomBytes` base64url output — an
 * alphabet with no quote characters at all — but the escaping is applied unconditionally so
 * correctness never depends on that assumption holding.
 */
async function createRole(client: Client, roleName: string, password: string): Promise<void> {
  const identifier = escapeIdentifier(roleName);
  const literal = escapeLiteral(password);

  try {
    await client.query(
      `CREATE ROLE ${identifier} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal}`,
    );
  } catch (error) {
    throw new TenantRoleProvisioningError("Failed to create tenant application role", { cause: error });
  }
}

async function alterRolePassword(client: Client, roleName: string, password: string): Promise<void> {
  const identifier = escapeIdentifier(roleName);
  const literal = escapeLiteral(password);

  try {
    await client.query(`ALTER ROLE ${identifier} WITH PASSWORD ${literal}`);
  } catch (error) {
    throw new TenantRoleProvisioningError("Failed to rotate tenant application role credential", {
      cause: error,
    });
  }
}

async function resolveExistingTenantSecret(
  secretStore: SecretStore,
  secretReference: string,
): Promise<TenantDatabaseCredential | undefined> {
  const raw = await secretStore.get(secretReference);
  if (raw === undefined) {
    return undefined;
  }

  const result = tenantDatabaseCredentialSchema.safeParse(raw);
  if (!result.success) {
    const invalidPaths = result.error.issues.map((issue) => issue.path.join(".") || "(root)");
    throw new InvalidTenantSecretError(secretReference, invalidPaths);
  }

  return result.data;
}

/**
 * Real, PostgreSQL-backed `TenantRoleProvisioner`. Resolves the cluster's administrative
 * credential, opens a short-lived connection scoped to this single `ensureRole` call (never
 * a pool kept globally per tenant), and reconciles the four possible (role, secret) states —
 * see `ensureRole` below.
 */
export function createPostgresTenantRoleProvisioner(deps: {
  clusterAdminCredentialResolver: ClusterAdminCredentialResolver;
  secretStore: SecretStore;
}): TenantRoleProvisioner {
  return {
    async ensureRole(input: {
      tenantId: string;
      cluster: DatabaseCluster;
    }): Promise<{ roleName: string; secretReference: string }> {
      const { tenantId, cluster } = input;
      const { roleName, secretReference } = buildProvisioningResourceNames(tenantId);
      assertSafeRoleName(roleName);

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
        // Discover the existing secret *before* touching the role: an invalid stored secret
        // must abort before any CREATE ROLE/ALTER ROLE, never silently overwrite it, and
        // never partially mutate the role first.
        const existingSecret = await resolveExistingTenantSecret(deps.secretStore, secretReference);
        const existingRole = await roleExists(client, roleName);

        if (existingRole && existingSecret) {
          // Case B — both already consistent; nothing to do, no rotation.
          return { roleName, secretReference };
        }

        if (!existingRole && existingSecret) {
          // Case D — a secret survived a prior CREATE ROLE that never landed (or ran
          // against a role that was later dropped). Reuse it rather than generating a new
          // password nobody asked to rotate.
          await createRole(client, roleName, existingSecret.password);
          return { roleName, secretReference };
        }

        // Cases A and C both need a freshly generated credential — a role can only ever be
        // told to use a specific password by us, so a missing/inconsistent secret always
        // means "give the role a new password we control." The password is applied to the
        // role first, and only saved to the SecretStore after that succeeds — the same
        // ordering ADR-003 already establishes for the reverse direction (secret must never
        // be considered saved before the role reflects it).
        const credential = createTenantDatabaseCredential(roleName);

        if (existingRole) {
          // Case C — role exists, secret missing/invalid-and-rejected-above: recovers a
          // prior CREATE ROLE that succeeded but whose SecretStore.put() never landed.
          await alterRolePassword(client, roleName, credential.password);
        } else {
          // Case A — genuinely new role.
          await createRole(client, roleName, credential.password);
        }

        await deps.secretStore.put(secretReference, credential);
        return { roleName, secretReference };
      } finally {
        await client.end();
      }
    },
  };
}
