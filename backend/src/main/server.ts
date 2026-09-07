import pino from "pino";

import { buildApp } from "../app/build-app.js";
import { env } from "../config/env.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createCloudflareR2ObjectStorage } from "../infrastructure/object-storage/cloudflare-r2-object-storage.js";
import { ObjectStorageConfigurationError } from "../infrastructure/object-storage/object-storage.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import {
  createRuntimeSecretStore,
  ProductionSecretStoreNotConfiguredError,
} from "../modules/provisioning/infrastructure/runtime-secret-store.js";
import { createPgTenantDatabaseConnectionManager } from "../modules/tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";

/**
 * Standalone API entrypoint — a real, separate process from `provisioning-worker.ts`/
 * `provisioning-dispatcher.ts` (Prompt 021, sections 33-36). Its `SecretStore` (Prompt 039:
 * `LocalFileSecretStore` at `env.DEV_SECRET_STORE_PATH`) is persistent and shared with every
 * other local process pointed at the same file — a tenant secret written by the provisioning
 * worker running as its own separate process IS visible here, as long as both use the default
 * (or an explicitly matching) `DEV_SECRET_STORE_PATH`. `dev-full.ts` (`pnpm dev:full`) remains
 * the simpler single-process convenience for local manual testing — see
 * ARCHITECTURE.md/README.md — but is no longer the only way to get secret-sharing locally.
 *
 * Refuses to start in production for the same reason `provisioning-worker.ts` already does: no
 * production-grade `SecretStore` provider exists yet (ADR-004: AWS Secrets Manager, status
 * PLANNED) — `createRuntimeSecretStore()` throws `ProductionSecretStoreNotConfiguredError`
 * rather than ever selecting the dev-only file store there.
 */
const logger = pino(createLoggerOptions());

let secretStore;
try {
  secretStore = createRuntimeSecretStore();
} catch (error) {
  if (error instanceof ProductionSecretStoreNotConfiguredError) {
    logger.fatal({ operation: "server.startup", reason: "no-production-secret-store" }, error.message);
    process.exit(1);
  }
  throw error;
}

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

const app = buildApp({
  tenantDatabaseConnectionManager,
  objectStorage,
  corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
});

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
