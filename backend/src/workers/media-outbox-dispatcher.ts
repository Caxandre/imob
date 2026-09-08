import pino from "pino";

import { controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import {
  createRuntimeSecretStore,
  ProductionSecretStoreNotConfiguredError,
} from "../modules/provisioning/infrastructure/runtime-secret-store.js";
import { createMediaOutboxDispatcherRuntime } from "./media-outbox-dispatcher-runtime.js";

/**
 * Standalone entrypoint for the media outbox dispatcher (Prompt 031, ADR-009) — discovers
 * eligible tenants through the Control Plane, then claims and transports each tenant's pending
 * `PROPERTY_MEDIA_PROCESSING_REQUESTED` outbox events to BullMQ. A real, multi-process
 * deployment topology: this process shares nothing in *memory* with `server.ts`,
 * `provisioning-worker.ts`, or `provisioning-dispatcher.ts`.
 *
 * Unlike `provisioning-dispatcher.ts` — which only ever touches the Control Plane and Redis,
 * and so has no `SecretStore` dependency at all — this dispatcher needs to open a real
 * connection to *each tenant's own* Tenant Data Plane database to claim its outbox rows, which
 * requires resolving that tenant's application credential from a `SecretStore`. Since Prompt
 * 039, its `SecretStore` (`LocalFileSecretStore`, `env.DEV_SECRET_STORE_PATH`) is persistent
 * and shared on disk with any other local process pointed at the same file — a tenant secret
 * the provisioning worker wrote (in its own separate process) IS resolvable here, as long as
 * both use the default (or an explicitly matching) `DEV_SECRET_STORE_PATH`. `src/main/dev-full.ts`
 * remains a convenience that composes this same runtime in one process instead of running it
 * standalone, but is no longer required just to share secrets locally. This standalone
 * entrypoint remains the real deployment shape once a production-grade `SecretStore` provider
 * exists (ADR-004).
 *
 * No production-grade `SecretStore` provider exists yet — same fail-fast as
 * `provisioning-worker.ts`: `createRuntimeSecretStore()` throws
 * `ProductionSecretStoreNotConfiguredError` under `NODE_ENV=production` rather than ever
 * selecting the dev-only file store there.
 */
const logger = pino(createLoggerOptions());

let secretStore;
try {
  secretStore = createRuntimeSecretStore();
} catch (error) {
  if (error instanceof ProductionSecretStoreNotConfiguredError) {
    logger.fatal(
      { operation: "media-outbox-dispatcher.startup", reason: "no-production-secret-store" },
      error.message,
    );
    process.exit(1);
  }
  throw error;
}

const runtime = createMediaOutboxDispatcherRuntime(secretStore, logger);

logger.info({ operation: "media-outbox-dispatcher.startup" }, "media outbox dispatcher started");

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ operation: "media-outbox-dispatcher.shutdown", signal }, "shutdown requested");
  await runtime.shutdown();
  await controlPlanePool.end();
  logger.info({ operation: "media-outbox-dispatcher.shutdown" }, "shutdown complete");
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
