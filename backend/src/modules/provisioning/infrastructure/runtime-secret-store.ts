import { env } from "../../../config/env.js";
import type { SecretStore } from "../application/secret-store.js";
import { createLocalFileSecretStore } from "./local-file-secret-store.js";

/**
 * Raised by `createRuntimeSecretStore()` under `NODE_ENV=production` (section 28/29) — thrown
 * rather than silently falling back to `LocalFileSecretStore` (a plaintext file is never
 * appropriate in production) or `InMemorySecretStore` (test/dev support only). Every caller
 * must catch this specifically and fail the process fast with its own operation-tagged log, the
 * same way each entrypoint already did before this factory existed.
 */
export class ProductionSecretStoreNotConfiguredError extends Error {
  constructor() {
    super(
      "No production-grade SecretStore provider exists yet (ADR-004: AWS Secrets Manager, " +
        "status PLANNED). LocalFileSecretStore is development-only and must never be selected " +
        "under NODE_ENV=production.",
    );
    this.name = "ProductionSecretStoreNotConfiguredError";
  }
}

/**
 * Centralizes the "which SecretStore backs this runtime" decision (Prompt 039, section 25) —
 * every standalone entrypoint (`server.ts`, `dev-full.ts`, `provisioning-worker.ts`,
 * `media-outbox-dispatcher.ts`, `media-processing-worker.ts`) calls this instead of branching on
 * `NODE_ENV` itself or constructing a store directly, so the decision lives in exactly one
 * place. Outside production: a `LocalFileSecretStore` at `env.DEV_SECRET_STORE_PATH`, persistent
 * across restarts and shared between local processes that point at the same file. In
 * production: always throws — never a file-based or in-memory fallback, since no
 * production-grade provider exists yet (ADR-004).
 */
export function createRuntimeSecretStore(): SecretStore {
  if (env.NODE_ENV === "production") {
    throw new ProductionSecretStoreNotConfiguredError();
  }

  return createLocalFileSecretStore(env.DEV_SECRET_STORE_PATH);
}
