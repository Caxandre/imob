import pino from "pino";

import { buildApp } from "../app/build-app.js";
import { env } from "../config/env.js";
import { controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createTenantDatabaseCredentialResolver } from "../modules/provisioning/application/tenant-database-credential-resolver.js";
import { createInMemorySecretStore } from "../modules/provisioning/test-support/in-memory-secret-store.js";
import { createPgTenantDatabaseConnectionManager } from "../modules/tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";
import { createProvisioningWorkerRuntime } from "../workers/provisioning-worker-runtime.js";
import { bootstrapLocalDevCluster } from "./dev-full-bootstrap.js";

/**
 * DEV-ONLY combined runtime: the HTTP API and the provisioning worker in a single process,
 * sharing one `SecretStore` instance. Exists solely to close a local-development gap
 * (`server.ts` and `provisioning-worker.ts` run as genuinely separate processes and do NOT
 * share `SecretStore` state — see their own docstrings and ARCHITECTURE.md), so that a tenant
 * provisioned locally can actually have its properties routes exercised manually through
 * Swagger without a real production-grade `SecretStore` provider (ADR-004: AWS Secrets
 * Manager, status PLANNED) existing yet.
 *
 * THIS IS NOT THE PRODUCTION TOPOLOGY. `server.ts`, `provisioning-worker.ts` and
 * `provisioning-dispatcher.ts` remain the real, independent entrypoints — this file changes
 * nothing about them and is never started alongside them for the same purpose (it duplicates
 * what they do, in one process, for local convenience only). Delete this file's role once
 * ADR-004 is implemented and a real dev secret-sharing story (or the production provider
 * itself) exists.
 *
 * Recommended local flow (README.md has the full walkthrough):
 *   docker compose up -d
 *   pnpm db:migrate
 *   pnpm dev:dispatcher   (separate terminal — still a separate process, this is fine)
 *   pnpm dev:full         (this file — API + provisioning worker, shared SecretStore)
 *   → POST /api/v1/tenants via Swagger, wait for the tenant to become READY
 *   → POST/GET /api/v1/properties via Swagger, using that tenant's id as X-Tenant-Id
 *
 * On startup, this entrypoint also runs `bootstrapLocalDevCluster()` (Prompt 024): it ensures
 * the local `database_clusters` row (`TENANT_DATABASE_DEFAULT_CLUSTER`) exists and (re-)seeds
 * its admin credential into this process's `SecretStore`, so the flow above works against a
 * fresh `docker compose up -d` + `.env` with no separate manual bootstrap step. Bootstrap
 * connection details come from the `DEV_BOOTSTRAP_CLUSTER_*` env vars (see `.env.example`) —
 * dev-only, read by nothing else.
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

const app = buildApp({ tenantDatabaseConnectionManager });

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

logger.info(
  { operation: "dev-full.startup" },
  "dev-only combined runtime started (API + provisioning worker, shared SecretStore)",
);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ operation: "dev-full.shutdown", signal }, "shutdown requested");
  // app.close() runs buildApp()'s own onClose hook, which closes tenantDatabaseConnectionManager.
  await Promise.all([app.close(), workerRuntime.shutdown()]);
  await controlPlanePool.end();
  logger.info({ operation: "dev-full.shutdown" }, "shutdown complete");
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
