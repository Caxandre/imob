import pino from "pino";

import { buildApp } from "../app/build-app.js";
import { env } from "../config/env.js";
import { controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createCloudflareR2ObjectStorage } from "../infrastructure/object-storage/cloudflare-r2-object-storage.js";
import { ObjectStorageConfigurationError } from "../infrastructure/object-storage/object-storage.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import { createInMemorySecretStore } from "../modules/provisioning/test-support/in-memory-secret-store.js";
import { createPgTenantDatabaseConnectionManager } from "../modules/tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";
import { createMediaOutboxDispatcherRuntime } from "../workers/media-outbox-dispatcher-runtime.js";
import { createProvisioningWorkerRuntime } from "../workers/provisioning-worker-runtime.js";
import { bootstrapLocalDevCluster } from "./dev-full-bootstrap.js";

/**
 * DEV-ONLY combined runtime: the HTTP API, the provisioning worker, and (Prompt 031) the media
 * outbox dispatcher in a single process, sharing one `SecretStore` instance. Exists solely to
 * close a local-development gap (`server.ts`/`provisioning-worker.ts`/
 * `media-outbox-dispatcher.ts` run as genuinely separate processes and do NOT share
 * `SecretStore` state — see their own docstrings and ARCHITECTURE.md), so that a tenant
 * provisioned locally can actually have its properties routes exercised manually through
 * Swagger, and its media outbox actually dispatched to BullMQ, without a real production-grade
 * `SecretStore` provider (ADR-004: AWS Secrets Manager, status PLANNED) existing yet.
 *
 * THIS IS NOT THE PRODUCTION TOPOLOGY. `server.ts`, `provisioning-worker.ts`,
 * `provisioning-dispatcher.ts`, and `media-outbox-dispatcher.ts` remain the real, independent
 * entrypoints — this file changes nothing about them and is never started alongside them for
 * the same purpose (it duplicates what they do, in one process, for local convenience only).
 * `provisioning-dispatcher.ts` is deliberately NOT composed in here (unlike the provisioning
 * worker and the media outbox dispatcher): it never resolves a tenant credential — only Control
 * Plane + Redis — so it has no `SecretStore`-sharing gap to close and stays a genuinely separate
 * process even for local development (see the recommended flow below). Delete this file's role
 * once ADR-004 is implemented and a real dev secret-sharing story (or the production provider
 * itself) exists.
 *
 * Recommended local flow (README.md has the full walkthrough):
 *   docker compose up -d
 *   pnpm db:migrate
 *   pnpm dev:dispatcher   (separate terminal — still a separate process, this is fine)
 *   pnpm dev:full         (this file — API + provisioning worker + media outbox dispatcher,
 *                          shared SecretStore)
 *   → POST /api/v1/tenants via Swagger, wait for the tenant to become READY
 *   → POST/GET /api/v1/properties via Swagger, using that tenant's id as X-Tenant-Id
 *   → POST /api/v1/properties/{id}/media uploads a photo; its outbox event is picked up by the
 *     media outbox dispatcher running in this same process within
 *     MEDIA_OUTBOX_DISPATCH_POLL_INTERVAL_MS and transported to the "media-processing" BullMQ
 *     queue — no worker consumes it yet (Prompt 031), so it stays queued; that is expected.
 *
 * On startup, this entrypoint also runs `bootstrapLocalDevCluster()` (Prompt 024): it ensures
 * the local `database_clusters` row (`TENANT_DATABASE_DEFAULT_CLUSTER`) exists and (re-)seeds
 * its admin credential into this process's `SecretStore`, so the flow above works against a
 * fresh `docker compose up -d` + `.env` with no separate manual bootstrap step. Bootstrap
 * connection details come from the `DEV_BOOTSTRAP_CLUSTER_*` env vars (see `.env.example`) —
 * dev-only, read by nothing else.
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
      "combined runtime (shared in-memory SecretStore, no production-grade provider exists " +
      "yet — see ADR-004). It must never run under NODE_ENV=production, independent of the " +
      "SecretStore's own guard.",
  );
  process.exit(1);
}

const secretStore = createInMemorySecretStore();

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

const app = buildApp({ tenantDatabaseConnectionManager, objectStorage });

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

logger.info(
  { operation: "dev-full.startup" },
  "dev-only combined runtime started (API + provisioning worker + media outbox dispatcher, shared SecretStore)",
);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ operation: "dev-full.shutdown", signal }, "shutdown requested");
  // app.close() runs buildApp()'s own onClose hook, which closes tenantDatabaseConnectionManager.
  await Promise.all([app.close(), workerRuntime.shutdown(), mediaOutboxDispatcherRuntime.shutdown()]);
  await controlPlanePool.end();
  logger.info({ operation: "dev-full.shutdown" }, "shutdown complete");
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
