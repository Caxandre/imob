import pino from "pino";

import { env } from "../config/env.js";
import { controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createInMemorySecretStore } from "../modules/provisioning/test-support/in-memory-secret-store.js";
import { createProvisioningWorkerRuntime } from "./provisioning-worker-runtime.js";

/**
 * Standalone entrypoint for the provisioning worker (tenant-provisioning queue consumer) plus
 * its independent RUNNING-recovery loop (ADR-003 "Recovery", Prompt 019) — a real,
 * multi-process deployment topology: this process shares nothing in memory with `server.ts`
 * or `provisioning-dispatcher.ts`. In particular, its `SecretStore` (in-memory, constructed
 * below) is private to this process — a tenant secret it writes during provisioning is NOT
 * visible to `server.ts` run separately (see `dev-full.ts` for the dev-only combined runtime
 * that closes this gap locally, and ARCHITECTURE.md for the full explanation).
 *
 * A real `DatabaseProvisioner` exists (Prompt 017) and the Control Plane finalization it feeds
 * is implemented (Prompt 018) — the trava that used to refuse to start unconditionally is
 * gone. What remains is narrower and still real: no production-grade `SecretStore` provider
 * exists yet (ADR-004: AWS Secrets Manager, status PLANNED). `createInMemorySecretStore()`
 * already refuses to construct under `NODE_ENV=production` on its own, but this entrypoint
 * checks explicitly and fails fast with a clear reason *before* wiring anything — never
 * silently falling back to it in a real deployment. Outside of production
 * (`development`/`test`), the worker starts for real and processes jobs end to end against
 * whatever `SecretStore`-shaped storage is configured — in-memory today, a real provider
 * whenever one is built.
 */
const logger = pino(createLoggerOptions());

if (env.NODE_ENV === "production") {
  logger.fatal(
    { operation: "provisioning-worker.startup", reason: "no-production-secret-store" },
    "Refusing to start in production: no production-grade SecretStore provider exists yet " +
      "(createInMemorySecretStore is test/dev support only, and refuses to construct under " +
      "NODE_ENV=production on its own). See ADR-004 and " +
      "src/modules/provisioning/test-support/in-memory-secret-store.ts.",
  );
  process.exit(1);
}

const secretStore = createInMemorySecretStore();
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
