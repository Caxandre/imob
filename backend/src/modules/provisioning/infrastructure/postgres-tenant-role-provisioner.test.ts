import { randomUUID } from "node:crypto";

import { Client, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createClusterAdminCredentialResolver } from "../application/cluster-admin-credential-resolver.js";
import type { DatabaseCluster } from "../application/database-cluster-selector.js";
import { buildProvisioningResourceNames } from "../application/provisioning-resource-names.js";
import type { SecretStore } from "../application/secret-store.js";
import {
  InvalidTenantSecretError,
  TenantRoleProvisioningError,
} from "../application/tenant-role-provisioner.js";
import { createInMemorySecretStore } from "../test-support/in-memory-secret-store.js";
import { createPostgresTenantRoleProvisioner } from "./postgres-tenant-role-provisioner.js";

/**
 * Real `postgres-tenants` (Docker Compose), not a mock — CREATE ROLE/ALTER ROLE behavior
 * must be proven against an actual server. Admin credentials match the service's
 * POSTGRES_USER/POSTGRES_PASSWORD; the admin secret itself only ever lives in an in-memory
 * SecretStore for this test run, never on disk.
 */
const ADMIN_SECRET_REFERENCE = "clusters/postgres-tenants-test-admin";
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";

const CLUSTER: DatabaseCluster = {
  id: "00000000-0000-0000-0000-000000000001",
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

interface RoleAttributes {
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

async function fetchRoleAttributes(roleName: string): Promise<RoleAttributes | undefined> {
  return withAdminClient(async (client) => {
    const result = await client.query<RoleAttributes>(
      "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [roleName],
    );
    return result.rows[0];
  });
}

async function countRole(roleName: string): Promise<number> {
  return withAdminClient(async (client) => {
    const result = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
    return result.rowCount ?? 0;
  });
}

/**
 * Proves a credential actually authenticates, without ever logging the password: opens a
 * real connection as the tenant role against the cluster's "postgres" maintenance database
 * and runs a trivial query. Safe to use here specifically because PostgreSQL grants CONNECT
 * on every database to PUBLIC by default — a freshly created role with no other grants can
 * already open this connection without us granting any extra privilege for the purpose of
 * this test (verified empirically against the real `postgres-tenants` container).
 */
async function canAuthenticate(username: string, password: string): Promise<boolean> {
  const client = new Client({
    host: CLUSTER.host,
    port: CLUSTER.port,
    database: "postgres",
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

/** Wraps a real SecretStore, making `put()` throw on the first N calls only. */
function withFailingPut(inner: SecretStore, failures: number): SecretStore {
  let remaining = failures;
  return {
    ...inner,
    async put(secretReference: string, value: unknown): Promise<void> {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("simulated SecretStore.put failure");
      }
      await inner.put(secretReference, value);
    },
  };
}

const createdRoleNames = new Set<string>();

function freshTenantId(): string {
  const tenantId = randomUUID();
  createdRoleNames.add(buildProvisioningResourceNames(tenantId).roleName);
  return tenantId;
}

afterEach(async () => {
  const roleNames = [...createdRoleNames];
  createdRoleNames.clear();
  await withAdminClient(async (client) => {
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

describe("createPostgresTenantRoleProvisioner", () => {
  it("Case A — creates a new role with the correct attributes and saves the secret", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const provisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
    const tenantId = freshTenantId();
    const expected = buildProvisioningResourceNames(tenantId);

    const result = await provisioner.ensureRole({ tenantId, cluster: CLUSTER });

    expect(result).toEqual({ roleName: expected.roleName, secretReference: expected.secretReference });

    const attributes = await fetchRoleAttributes(expected.roleName);
    expect(attributes).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    });

    const savedSecret = await secretStore.get(expected.secretReference);
    expect(savedSecret).toMatchObject({ username: expected.roleName });

    const { password } = savedSecret as { password: string };
    await expect(canAuthenticate(expected.roleName, password)).resolves.toBe(true);
  });

  it("is idempotent: a second call returns the same role/secret without rotating the password", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const provisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
    const tenantId = freshTenantId();
    const expected = buildProvisioningResourceNames(tenantId);

    const first = await provisioner.ensureRole({ tenantId, cluster: CLUSTER });
    const firstSecret = await secretStore.get(expected.secretReference);

    const second = await provisioner.ensureRole({ tenantId, cluster: CLUSTER });
    const secondSecret = await secretStore.get(expected.secretReference);

    expect(second).toEqual(first);
    expect(secondSecret).toEqual(firstSecret);
    await expect(countRole(expected.roleName)).resolves.toBe(1);
  });

  it("Case C — role exists, secret missing: generates a new credential, ALTER ROLEs it, saves the secret", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const provisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
    const tenantId = freshTenantId();
    const expected = buildProvisioningResourceNames(tenantId);

    await provisioner.ensureRole({ tenantId, cluster: CLUSTER });
    const originalSecret = (await secretStore.get(expected.secretReference)) as { password: string };
    await secretStore.delete(expected.secretReference);

    await provisioner.ensureRole({ tenantId, cluster: CLUSTER });

    const rotatedSecret = (await secretStore.get(expected.secretReference)) as { password: string };
    expect(rotatedSecret.password).not.toBe(originalSecret.password);
    await expect(countRole(expected.roleName)).resolves.toBe(1);
    await expect(canAuthenticate(expected.roleName, rotatedSecret.password)).resolves.toBe(true);
    await expect(canAuthenticate(expected.roleName, originalSecret.password)).resolves.toBe(false);
  });

  it("Case D — secret exists, role missing: creates the role reusing the existing credential, without rotating it", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const provisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
    const tenantId = freshTenantId();
    const expected = buildProvisioningResourceNames(tenantId);
    const preExistingCredential = { username: expected.roleName, password: "pre-existing-secret-value" };
    await secretStore.put(expected.secretReference, preExistingCredential);

    const result = await provisioner.ensureRole({ tenantId, cluster: CLUSTER });

    expect(result).toEqual({ roleName: expected.roleName, secretReference: expected.secretReference });
    await expect(secretStore.get(expected.secretReference)).resolves.toEqual(preExistingCredential);
    await expect(canAuthenticate(expected.roleName, preExistingCredential.password)).resolves.toBe(true);
  });

  it("secret invalid: throws InvalidTenantSecretError without touching the role or the stored secret", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const provisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
    const tenantId = freshTenantId();
    const expected = buildProvisioningResourceNames(tenantId);
    const invalidPayload = { username: expected.roleName };
    await secretStore.put(expected.secretReference, invalidPayload);

    await expect(provisioner.ensureRole({ tenantId, cluster: CLUSTER })).rejects.toThrow(
      InvalidTenantSecretError,
    );

    await expect(countRole(expected.roleName)).resolves.toBe(0);
    await expect(secretStore.get(expected.secretReference)).resolves.toEqual(invalidPayload);
  });

  it("recovers from a CREATE ROLE that succeeded but whose SecretStore.put() failed, without creating a second role", async () => {
    const { secretStore: innerStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(innerStore);
    const tenantId = freshTenantId();
    const expected = buildProvisioningResourceNames(tenantId);

    const flakyStore = withFailingPut(innerStore, 1);
    const flakyProvisioner = createPostgresTenantRoleProvisioner({
      secretStore: flakyStore,
      clusterAdminCredentialResolver,
    });

    await expect(flakyProvisioner.ensureRole({ tenantId, cluster: CLUSTER })).rejects.toThrow(
      "simulated SecretStore.put failure",
    );
    // CREATE ROLE itself must have gone through, even though the overall call rejected.
    await expect(countRole(expected.roleName)).resolves.toBe(1);
    await expect(innerStore.get(expected.secretReference)).resolves.toBeUndefined();

    const retryProvisioner = createPostgresTenantRoleProvisioner({
      secretStore: innerStore,
      clusterAdminCredentialResolver,
    });
    const result = await retryProvisioner.ensureRole({ tenantId, cluster: CLUSTER });

    expect(result).toEqual({ roleName: expected.roleName, secretReference: expected.secretReference });
    await expect(countRole(expected.roleName)).resolves.toBe(1);
    const recoveredSecret = await innerStore.get(expected.secretReference);
    expect(recoveredSecret).toMatchObject({ username: expected.roleName });
  });

  it("never claims success when CREATE ROLE itself fails (real conflicting concurrent CREATE ROLE)", async () => {
    const { secretStore, clusterAdminCredentialResolver } = buildDeps();
    await seedAdminSecret(secretStore);
    const provisioner = createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver });
    const tenantId = freshTenantId();
    const expected = buildProvisioningResourceNames(tenantId);

    // Two genuinely concurrent calls for the same never-before-seen tenantId: both observe
    // "role does not exist" and both attempt CREATE ROLE — PostgreSQL allows only one to
    // succeed, giving a real (not simulated) CREATE ROLE failure for the other.
    const results = await Promise.allSettled([
      provisioner.ensureRole({ tenantId, cluster: CLUSTER }),
      provisioner.ensureRole({ tenantId, cluster: CLUSTER }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TenantRoleProvisioningError);

    // Exactly one role ever exists — the failed attempt never left a second one behind, and
    // never saved a secret for a role it didn't actually create.
    await expect(countRole(expected.roleName)).resolves.toBe(1);
    const savedSecret = await secretStore.get(expected.secretReference);
    expect(savedSecret).toMatchObject({ username: expected.roleName });
  });
});
