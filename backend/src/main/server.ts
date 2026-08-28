import pino from "pino";

import { buildApp } from "../app/build-app.js";
import { env } from "../config/env.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createCloudflareR2ObjectStorage } from "../infrastructure/object-storage/cloudflare-r2-object-storage.js";
import { ObjectStorageConfigurationError } from "../infrastructure/object-storage/object-storage.js";
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

// This server registers property media upload routes (Prompt 027), so a real Cloudflare R2
// adapter is constructed eagerly, at startup — never lazily on the first upload request. An
// incomplete R2_* configuration must fail loudly here (this task, section 51), not let the
// route exist and only fail confusingly on first use. No NODE_ENV guard, unlike the temporary
// InMemorySecretStore above — R2 is a real provider, valid in every environment once
// configured (ADR-006, section 45).
let objectStorage;
try {
  objectStorage = createCloudflareR2ObjectStorage({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicUrl: env.R2_PUBLIC_URL,
  });
} catch (error) {
  if (error instanceof ObjectStorageConfigurationError) {
    logger.fatal(
      { operation: "server.startup", err: error },
      "Refusing to start: Cloudflare R2 is not fully configured, but this server registers " +
        "property media upload routes that require it. Set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/" +
        "R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_PUBLIC_URL — see .env.example and ADR-006.",
    );
    process.exit(1);
  }
  throw error;
}

const app = buildApp({ tenantDatabaseConnectionManager, objectStorage });

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
