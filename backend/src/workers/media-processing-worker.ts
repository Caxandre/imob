import pino from "pino";

import { env } from "../config/env.js";
import { controlPlanePool } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createCloudflareR2ObjectStorage } from "../infrastructure/object-storage/cloudflare-r2-object-storage.js";
import { ObjectStorageConfigurationError } from "../infrastructure/object-storage/object-storage.js";
import { createInMemorySecretStore } from "../modules/provisioning/test-support/in-memory-secret-store.js";
import { createMediaProcessingWorkerRuntime } from "./media-processing-worker-runtime.js";

/**
 * Standalone entrypoint for the media processing worker (Prompt 032, ADR-008) — consumes the
 * `media-processing` BullMQ queue: downloads each media's original from Cloudflare R2, generates
 * THUMBNAIL/CARD/DETAIL variants with `sharp`, uploads them, and finalizes `property_media` as
 * `READY`/`FAILED`. A real, multi-process deployment topology: this process shares nothing in
 * memory with `server.ts`, `provisioning-worker.ts`, `provisioning-dispatcher.ts`, or
 * `media-outbox-dispatcher.ts`.
 *
 * Like `media-outbox-dispatcher.ts` (and unlike `provisioning-dispatcher.ts`, which never
 * resolves a tenant credential), this worker needs to open a real connection to *each tenant's
 * own* Tenant Data Plane database, which requires resolving that tenant's application credential
 * from a `SecretStore`. Run as a genuinely separate process with its own fresh, empty
 * `createInMemorySecretStore()` (below), it can never resolve any real tenant credential — every
 * job it picks up will fail with `TenantSecretNotFoundError` (a transient-shaped failure, so
 * BullMQ retries it — and every retry fails the same way, until retries are exhausted and the
 * media ends up `FAILED` for a reason that has nothing to do with the image itself). This is the
 * exact same cross-process gap already documented for `provisioning-worker.ts` vs `server.ts`
 * (ARCHITECTURE.md "Local development runtime") — not a bug introduced here, and not silently
 * worked around: `src/main/dev-full.ts` closes it locally by composing this same runtime with
 * the *same* `SecretStore` instance the provisioning worker writes tenant secrets into (this
 * task, section 31/32), which is the supported way to exercise this worker end-to-end in local
 * development. This standalone entrypoint remains the real deployment shape once a
 * production-grade `SecretStore` provider exists (ADR-004).
 *
 * No production-grade `SecretStore` provider exists yet — same fail-fast as
 * `provisioning-worker.ts`/`media-outbox-dispatcher.ts` (this task, section 33): refuses to
 * start under `NODE_ENV=production`, never silently falling back to the in-memory store in a
 * real deployment. Also requires a fully-configured Cloudflare R2 adapter eagerly, at startup —
 * this worker's entire job is reading/writing R2 objects, so an incomplete `R2_*` configuration
 * must fail loudly here, never lazily on the first job it picks up (same convention as
 * `server.ts`/`dev-full.ts` for the upload route).
 */
const logger = pino(createLoggerOptions());

if (env.NODE_ENV === "production") {
  logger.fatal(
    { operation: "media-processing-worker.startup", reason: "no-production-secret-store" },
    "Refusing to start in production: no production-grade SecretStore provider exists yet " +
      "(createInMemorySecretStore is test/dev support only, and refuses to construct under " +
      "NODE_ENV=production on its own). See ADR-004 and " +
      "src/modules/provisioning/test-support/in-memory-secret-store.ts.",
  );
  process.exit(1);
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

const secretStore = createInMemorySecretStore();
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
