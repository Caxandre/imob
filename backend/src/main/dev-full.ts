import pino from "pino";

import { buildApp } from "../app/build-app.js";
import { env } from "../config/env.js";
import { controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createCloudflareR2ObjectStorage } from "../infrastructure/object-storage/cloudflare-r2-object-storage.js";
import { ObjectStorageConfigurationError } from "../infrastructure/object-storage/object-storage.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import {
  createRuntimeSecretStore,
  ProductionSecretStoreNotConfiguredError,
} from "../modules/provisioning/infrastructure/runtime-secret-store.js";
import { createPgTenantDatabaseConnectionManager } from "../modules/tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";
import { createMediaOutboxDispatcherRuntime } from "../workers/media-outbox-dispatcher-runtime.js";
import { createMediaProcessingWorkerRuntime } from "../workers/media-processing-worker-runtime.js";
import { createProvisioningWorkerRuntime } from "../workers/provisioning-worker-runtime.js";
import { bootstrapLocalDevCluster } from "./dev-full-bootstrap.js";

/**
 * DEV-ONLY combined runtime: the HTTP API, the provisioning worker, the media outbox dispatcher
 * (Prompt 031), and (Prompt 032) the media processing worker in a single process. Historically
 * (before Prompt 039) this was the *only* way to get these pieces sharing a `SecretStore`
 * locally, since `server.ts`/`provisioning-worker.ts`/`media-outbox-dispatcher.ts`/
 * `media-processing-worker.ts` run as genuinely separate processes. Since Prompt 039, the
 * `SecretStore` itself (`LocalFileSecretStore`, `env.DEV_SECRET_STORE_PATH`) is persistent and
 * shared by *any* local process pointed at the same file — so this combined runtime is now a
 * convenience (one terminal instead of four), not the only way to close that gap.
 *
 * THIS IS NOT THE PRODUCTION TOPOLOGY. `server.ts`, `provisioning-worker.ts`,
 * `provisioning-dispatcher.ts`, `media-outbox-dispatcher.ts`, and `media-processing-worker.ts`
 * remain the real, independent entrypoints — this file changes nothing about them and is never
 * started alongside them for the same purpose (it duplicates what they do, in one process, for
 * local convenience only). `provisioning-dispatcher.ts` is deliberately NOT composed in here
 * (unlike the other three): it never resolves a tenant credential — only Control Plane + Redis —
 * so it has nothing to do with `SecretStore` sharing and stays a genuinely separate process even
 * for local development (see the recommended flow below). Delete this file's role once ADR-004
 * (a real production-grade `SecretStore` provider) is implemented.
 *
 * Recommended local flow (README.md has the full walkthrough):
 *   docker compose up -d
 *   pnpm db:migrate
 *   pnpm dev:dispatcher   (separate terminal — still a separate process, this is fine)
 *   pnpm dev:full         (this file — API + provisioning worker + media outbox dispatcher +
 *                          media processing worker, persistent local SecretStore)
 *   → POST /api/v1/tenants via Swagger, wait for the tenant to become READY
 *   → POST/GET /api/v1/properties via Swagger, using that tenant's id as X-Tenant-Id
 *   → POST /api/v1/properties/{id}/media uploads a photo; its outbox event is picked up by the
 *     media outbox dispatcher within MEDIA_OUTBOX_DISPATCH_POLL_INTERVAL_MS, transported to the
 *     "media-processing" BullMQ queue, and then consumed by the media processing worker running
 *     in this same process — `GET .../media` should show `processing_status: "READY"` shortly
 *     after (Prompt 032). Since Prompt 039, restarting `dev:full` no longer loses a
 *     previously-provisioned tenant's credential — the same `tenantId` keeps working across
 *     restarts (see ARCHITECTURE.md "Local development runtime").
 *
 * On startup, this entrypoint also runs `bootstrapLocalDevCluster()` (Prompt 024): it ensures
 * the local `database_clusters` row (`TENANT_DATABASE_DEFAULT_CLUSTER`) exists and (re-)seeds
 * its admin credential into the local `SecretStore`, so the flow above works against a fresh
 * `docker compose up -d` + `.env` with no separate manual bootstrap step — this remains
 * unconditional on every startup (never skipped just because the store is now persistent), both
 * because it's cheap/idempotent and because it lets a locally-changed
 * `DEV_BOOTSTRAP_CLUSTER_ADMIN_PASSWORD` actually take effect. Bootstrap connection details come
 * from the `DEV_BOOTSTRAP_CLUSTER_*` env vars (see `.env.example`) — dev-only, read by nothing
 * else.
 *
 * Since Prompt 027, this runtime also registers property media upload routes, which require a
 * real Cloudflare R2 adapter (ADR-006) — `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/
 * `R2_SECRET_ACCESS_KEY`/`R2_BUCKET`/`R2_PUBLIC_URL` are now a real requirement to start
 * `dev:full` (never lazily deferred to the first upload attempt — section 51/52).
 */
const logger = pino(createLoggerOptions());

if (env.NODE_ENV === "production") {
  logger.fatal(
    { operation: "dev-full.startup", reason: "dev-only-entrypoint-in-production" },
    "Refusing to start in production: src/main/dev-full.ts is a local-development-only " +
      "combined runtime (persistent file-based SecretStore, no production-grade provider " +
      "exists yet — see ADR-004). It must never run under NODE_ENV=production, independent of " +
      "the SecretStore factory's own guard.",
  );
  process.exit(1);
}

let secretStore;
try {
  secretStore = createRuntimeSecretStore();
} catch (error) {
  if (error instanceof ProductionSecretStoreNotConfiguredError) {
    // Unreachable given the NODE_ENV check right above, but kept for the same reason every
    // other entrypoint keeps this catch: never let a future refactor accidentally remove the
    // outer guard and silently fall through to an uncaught throw here.
    logger.fatal({ operation: "dev-full.startup", reason: "no-production-secret-store" }, error.message);
    process.exit(1);
  }
  throw error;
}

await bootstrapLocalDevCluster(secretStore, logger, {
  clusterName: env.TENANT_DATABASE_DEFAULT_CLUSTER,
  host: env.DEV_BOOTSTRAP_CLUSTER_HOST,
  port: env.DEV_BOOTSTRAP_CLUSTER_PORT,
  adminUsername: env.DEV_BOOTSTRAP_CLUSTER_ADMIN_USERNAME,
  adminPassword: env.DEV_BOOTSTRAP_CLUSTER_ADMIN_PASSWORD,
});

const tenantDatabaseConnectionManager = createPgTenantDatabaseConnectionManager({
  credentialResolver: createTenantDatabaseCredentialResolver(secretStore),
});

const workerRuntime = createProvisioningWorkerRuntime(secretStore, logger);
const mediaOutboxDispatcherRuntime = createMediaOutboxDispatcherRuntime(secretStore, logger);

// Same eager, fail-fast construction as server.ts (this task, section 52) — dev:full also
// registers the property media upload routes, so R2 env becomes a real requirement to start
// this runtime too, not something that only surfaces on the first upload attempt.
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
      { operation: "dev-full.startup", err: error },
      "Refusing to start: Cloudflare R2 is not fully configured, but this runtime registers " +
        "property media upload routes that require it. Set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/" +
        "R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_PUBLIC_URL — see .env.example and ADR-006.",
    );
    process.exit(1);
  }
  throw error;
}

const mediaProcessingWorkerRuntime = createMediaProcessingWorkerRuntime(secretStore, objectStorage, logger);

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

logger.info(
  { operation: "dev-full.startup" },
  "dev-only combined runtime started (API + provisioning worker + media outbox dispatcher + media processing worker, persistent local SecretStore)",
);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ operation: "dev-full.shutdown", signal }, "shutdown requested");
  // app.close() runs buildApp()'s own onClose hook, which closes tenantDatabaseConnectionManager.
  await Promise.all([
    app.close(),
    workerRuntime.shutdown(),
    mediaOutboxDispatcherRuntime.shutdown(),
    mediaProcessingWorkerRuntime.shutdown(),
  ]);
  await controlPlanePool.end();
  logger.info({ operation: "dev-full.shutdown" }, "shutdown complete");
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
