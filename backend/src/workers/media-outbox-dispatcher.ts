import pino from "pino";

import { env } from "../config/env.js";
import { controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createInMemorySecretStore } from "../modules/provisioning/test-support/in-memory-secret-store.js";
import { createMediaOutboxDispatcherRuntime } from "./media-outbox-dispatcher-runtime.js";

/**
 * Standalone entrypoint for the media outbox dispatcher (Prompt 031, ADR-009) — discovers
 * eligible tenants through the Control Plane, then claims and transports each tenant's pending
 * `PROPERTY_MEDIA_PROCESSING_REQUESTED` outbox events to BullMQ. A real, multi-process
 * deployment topology: this process shares nothing in memory with `server.ts`,
 * `provisioning-worker.ts`, or `provisioning-dispatcher.ts`.
 *
 * Unlike `provisioning-dispatcher.ts` — which only ever touches the Control Plane and Redis,
 * and so has no `SecretStore` dependency at all — this dispatcher needs to open a real
 * connection to *each tenant's own* Tenant Data Plane database to claim its outbox rows, which
 * requires resolving that tenant's application credential from a `SecretStore` (this task,
 * section 40/41). Run as a genuinely separate process with its own fresh, empty
 * `createInMemorySecretStore()` (below), it can never resolve any real tenant credential — every
 * tenant a cycle discovers will fail with `TenantSecretNotFoundError`, caught and logged per
 * tenant (never crashing the process, never blocking other tenants — see
 * `media-outbox-dispatcher-runtime.ts`), but never actually dispatching anything either. This is
 * the exact same cross-process gap already documented for `provisioning-worker.ts` vs
 * `server.ts` (ARCHITECTURE.md "Local development runtime") — not a bug introduced here, and not
 * silently worked around: `src/main/dev-full.ts` closes it locally by composing this same
 * runtime with the *same* `SecretStore` instance the provisioning worker writes tenant secrets
 * into (this task, section 42/43), which is the supported way to exercise this dispatcher
 * end-to-end in local development. This standalone entrypoint remains the real deployment shape
 * once a production-grade `SecretStore` provider exists (ADR-004) and every process in the
 * topology can share it through that provider instead of process memory.
 *
 * No production-grade `SecretStore` provider exists yet — same fail-fast as
 * `provisioning-worker.ts`: `createInMemorySecretStore()` already refuses to construct under
 * `NODE_ENV=production` on its own, but this entrypoint checks explicitly and fails fast with a
 * clear reason before wiring anything, never silently falling back to it in a real deployment.
 */
const logger = pino(createLoggerOptions());

if (env.NODE_ENV === "production") {
  logger.fatal(
    { operation: "media-outbox-dispatcher.startup", reason: "no-production-secret-store" },
    "Refusing to start in production: no production-grade SecretStore provider exists yet " +
      "(createInMemorySecretStore is test/dev support only, and refuses to construct under " +
      "NODE_ENV=production on its own). See ADR-004 and " +
      "src/modules/provisioning/test-support/in-memory-secret-store.ts.",
  );
  process.exit(1);
}

const secretStore = createInMemorySecretStore();
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
