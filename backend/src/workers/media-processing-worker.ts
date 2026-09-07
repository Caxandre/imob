import pino from "pino";

import { env } from "../config/env.js";
import { controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createCloudflareR2ObjectStorage } from "../infrastructure/object-storage/cloudflare-r2-object-storage.js";
import { ObjectStorageConfigurationError } from "../infrastructure/object-storage/object-storage.js";
import {
  createRuntimeSecretStore,
  ProductionSecretStoreNotConfiguredError,
} from "../modules/provisioning/infrastructure/runtime-secret-store.js";
import { createMediaProcessingWorkerRuntime } from "./media-processing-worker-runtime.js";

/**
 * Standalone entrypoint for the media processing worker (Prompt 032, ADR-008) — consumes the
 * `media-processing` BullMQ queue: downloads each media's original from Cloudflare R2, generates
 * THUMBNAIL/CARD/DETAIL variants with `sharp`, uploads them, and finalizes `property_media` as
 * `READY`/`FAILED`. A real, multi-process deployment topology: this process shares nothing in
 * *memory* with `server.ts`, `provisioning-worker.ts`, `provisioning-dispatcher.ts`, or
 * `media-outbox-dispatcher.ts`.
 *
 * Like `media-outbox-dispatcher.ts` (and unlike `provisioning-dispatcher.ts`, which never
 * resolves a tenant credential), this worker needs to open a real connection to *each tenant's
 * own* Tenant Data Plane database, which requires resolving that tenant's application credential
 * from a `SecretStore`. Since Prompt 039, its `SecretStore` (`LocalFileSecretStore`,
 * `env.DEV_SECRET_STORE_PATH`) is persistent and shared on disk with any other local process
 * pointed at the same file — a tenant secret the provisioning worker wrote (in its own separate
 * process) IS resolvable here, as long as both use the default (or an explicitly matching)
 * `DEV_SECRET_STORE_PATH`. `src/main/dev-full.ts` remains a convenience that composes this same
 * runtime in one process instead of running it standalone, but is no longer required just to
 * share secrets locally. This standalone entrypoint remains the real deployment shape once a
 * production-grade `SecretStore` provider exists (ADR-004).
 *
 * No production-grade `SecretStore` provider exists yet — same fail-fast as
 * `provisioning-worker.ts`/`media-outbox-dispatcher.ts`: `createRuntimeSecretStore()` throws
 * `ProductionSecretStoreNotConfiguredError` under `NODE_ENV=production` rather than ever
 * selecting the dev-only file store there. Also requires a fully-configured Cloudflare R2
 * adapter eagerly, at startup — this worker's entire job is reading/writing R2 objects, so an
 * incomplete `R2_*` configuration must fail loudly here, never lazily on the first job it picks
 * up (same convention as `server.ts`/`dev-full.ts` for the upload route).
 */
const logger = pino(createLoggerOptions());

let secretStore;
try {
  secretStore = createRuntimeSecretStore();
} catch (error) {
  if (error instanceof ProductionSecretStoreNotConfiguredError) {
    logger.fatal(
      { operation: "media-processing-worker.startup", reason: "no-production-secret-store" },
      error.message,
    );
    process.exit(1);
  }
  throw error;
}

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
      { operation: "media-processing-worker.startup", err: error },
      "Refusing to start: Cloudflare R2 is not fully configured, but this worker reads/writes " +
        "property media objects that require it. Set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/" +
        "R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_PUBLIC_URL — see .env.example and ADR-006.",
    );
    process.exit(1);
  }
  throw error;
}

const runtime = createMediaProcessingWorkerRuntime(secretStore, objectStorage, logger);

logger.info({ operation: "media-processing-worker.startup" }, "media processing worker started");

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ operation: "media-processing-worker.shutdown", signal }, "shutdown requested");
  await runtime.shutdown();
  await controlPlanePool.end();
  logger.info({ operation: "media-processing-worker.shutdown" }, "shutdown complete");
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
