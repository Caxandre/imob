import { createTenantDatabaseCredentialResolver } from "../../modules/provisioning/application/tenant-database-credential-resolver.js";
import type { SecretStore } from "../../modules/provisioning/application/secret-store.js";
import { createInMemorySecretStore } from "../../modules/provisioning/test-support/in-memory-secret-store.js";
import { createPgTenantDatabaseConnectionManager } from "../../modules/tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";
import type { ObjectStorage } from "../../infrastructure/object-storage/object-storage.js";
import { createInMemoryObjectStorage } from "../../infrastructure/object-storage/test-support/in-memory-object-storage.js";
import { buildApp } from "../build-app.js";

/**
 * Test-support only: builds a real `FastifyInstance` with a real, Postgres-backed
 * `TenantDatabaseConnectionManager` — never a mock. Tests that don't touch tenant runtime at
 * all (health/docs/tenant CRUD) can call this with no arguments. Tests that do (Properties
 * HTTP integration tests) pass the exact same `SecretStore` instance they used to provision
 * the tenant under test, in the same process — the same pattern already used by
 * `e2e-tenant-database-runtime.test.ts` — so the credential the connection manager resolves
 * actually exists.
 *
 * `objectStorage` defaults to an in-memory fake (this task, section 55/56) — `buildApp()`
 * itself never provides one on its own; this is the one explicit place tests get one without
 * needing real R2 credentials. Tests that specifically need to observe/control uploads (media
 * routes) pass their own instance.
 */
export function buildTestApp(
  secretStore: SecretStore = createInMemorySecretStore(),
  objectStorage: ObjectStorage = createInMemoryObjectStorage(),
) {
  const tenantDatabaseConnectionManager = createPgTenantDatabaseConnectionManager({
    credentialResolver: createTenantDatabaseCredentialResolver(secretStore),
  });

  return buildApp({ tenantDatabaseConnectionManager, objectStorage });
}
