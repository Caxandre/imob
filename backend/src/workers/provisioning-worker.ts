import pino from "pino";

import { controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import {
  createRuntimeSecretStore,
  ProductionSecretStoreNotConfiguredError,
} from "../modules/provisioning/infrastructure/runtime-secret-store.js";
import { createProvisioningWorkerRuntime } from "./provisioning-worker-runtime.js";

/**
 * Standalone entrypoint for the provisioning worker (tenant-provisioning queue consumer) plus
 * its independent RUNNING-recovery loop (ADR-003 "Recovery", Prompt 019) — a real,
 * multi-process deployment topology: this process shares nothing in *memory* with `server.ts`
 * or `provisioning-dispatcher.ts`. Since Prompt 039, its `SecretStore`
 * (`LocalFileSecretStore`, `env.DEV_SECRET_STORE_PATH`) is persistent and shared on disk with
 * any other local process pointed at the same file — a tenant secret this worker writes during
 * provisioning IS visible to `server.ts` run separately, as long as both use the default (or an
 * explicitly matching) `DEV_SECRET_STORE_PATH`. `dev-full.ts` remains a convenience that runs
 * everything in one process, but is no longer required just to share secrets locally.
 *
 * A real `DatabaseProvisioner` exists (Prompt 017) and the Control Plane finalization it feeds
 * is implemented (Prompt 018) — the trava that used to refuse to start unconditionally is
 * gone. What remains is narrower and still real: no production-grade `SecretStore` provider
 * exists yet (ADR-004: AWS Secrets Manager, status PLANNED) —
 * `createRuntimeSecretStore()` throws `ProductionSecretStoreNotConfiguredError` under
 * `NODE_ENV=production` rather than ever selecting the dev-only file store there. Outside of
 * production (`development`/`test`), the worker starts for real and processes jobs end to end
 * against the local file-backed store.
 */
const logger = pino(createLoggerOptions());

let secretStore;
try {
  secretStore = createRuntimeSecretStore();
} catch (error) {
  if (error instanceof ProductionSecretStoreNotConfiguredError) {
    logger.fatal(
      { operation: "provisioning-worker.startup", reason: "no-production-secret-store" },
      error.message,
    );
    process.exit(1);
  }
  throw error;
}

const runtime = createProvisioningWorkerRuntime(secretStore, logger);

logger.info({ operation: "provisioning-worker.startup" }, "provisioning worker started");

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ operation: "provisioning-worker.shutdown", signal }, "shutdown requested");
  await runtime.shutdown();
  await controlPlanePool.end();
  logger.info({ operation: "provisioning-worker.shutdown" }, "shutdown complete");
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
