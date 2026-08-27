import pino from "pino";

import { buildApp } from "../app/build-app.js";
import { env } from "../config/env.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import { createInMemorySecretStore } from "../modules/provisioning/test-support/in-memory-secret-store.js";
import { createPgTenantDatabaseConnectionManager } from "../modules/tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";

/**
 * Standalone API entrypoint — a real, separate process from `provisioning-worker.ts`/
 * `provisioning-dispatcher.ts` (this task, Prompt 021, sections 33-36). Its `SecretStore` is
 * private, in-memory, and constructed fresh right here: a tenant secret written by the
 * provisioning worker running as its own process is NOT visible to this one. That means
 * `POST /api/v1/properties` against a tenant provisioned by the standalone worker will fail
 * to resolve that tenant's credential in this configuration — an honest, documented gap, not
 * silently worked around (never falls back to the cluster admin credential). Use
 * `dev-full.ts` (`pnpm dev:full`) for local manual testing that needs both provisioning and
 * property routes to share the same tenant secrets — see ARCHITECTURE.md/README.md.
 *
 * Refuses to start in production for the same reason `provisioning-worker.ts` already does:
 * no production-grade `SecretStore` provider exists yet (ADR-004: AWS Secrets Manager, status
 * PLANNED). `createInMemorySecretStore()` already refuses to construct under
 * `NODE_ENV=production` on its own; this entrypoint checks explicitly first so the failure is
 * a clean, logged `process.exit(1)` rather than an uncaught construction error.
 */
const logger = pino(createLoggerOptions());

if (env.NODE_ENV === "production") {
  logger.fatal(
    { operation: "server.startup", reason: "no-production-secret-store" },
    "Refusing to start in production: no production-grade SecretStore provider exists yet " +
      "(createInMemorySecretStore is test/dev support only, and refuses to construct under " +
      "NODE_ENV=production on its own). See ADR-004 and " +
      "src/modules/provisioning/test-support/in-memory-secret-store.ts.",
  );
  process.exit(1);
}

const secretStore = createInMemorySecretStore();
const tenantDatabaseConnectionManager = createPgTenantDatabaseConnectionManager({
  credentialResolver: createTenantDatabaseCredentialResolver(secretStore),
});

const app = buildApp({ tenantDatabaseConnectionManager });

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
