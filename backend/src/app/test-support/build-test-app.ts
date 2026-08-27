import { createTenantDatabaseCredentialResolver } from "../../modules/provisioning/application/tenant-database-credential-resolver.js";
import type { SecretStore } from "../../modules/provisioning/application/secret-store.js";
import { createInMemorySecretStore } from "../../modules/provisioning/test-support/in-memory-secret-store.js";
import { createPgTenantDatabaseConnectionManager } from "../../modules/tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";
import { buildApp } from "../build-app.js";

/**
 * Test-support only: builds a real `FastifyInstance` with a real, Postgres-backed
 * `TenantDatabaseConnectionManager` — never a mock. Tests that don't touch tenant runtime at
 * all (health/docs/tenant CRUD) can call this with no arguments. Tests that do (Properties
 * HTTP integration tests) pass the exact same `SecretStore` instance they used to provision
 * the tenant under test, in the same process — the same pattern already used by
 * `e2e-tenant-database-runtime.test.ts` — so the credential the connection manager resolves
 * actually exists.
 */
export function buildTestApp(secretStore: SecretStore = createInMemorySecretStore()) {
  const tenantDatabaseConnectionManager = createPgTenantDatabaseConnectionManager({
    credentialResolver: createTenantDatabaseCredentialResolver(secretStore),
  });

  return buildApp({ tenantDatabaseConnectionManager });
}
