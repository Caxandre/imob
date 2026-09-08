import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `env.ts` (imported transitively by `runtime-secret-store.ts`) is a module-level singleton
 * loaded once from `process.env` — exercising the `NODE_ENV=production` branch here needs a
 * fresh module instance, same `vi.resetModules()` + dynamic `import()` approach as
 * `config/env.test.ts`. Every other required env var is already set globally by
 * `vitest.config.ts`.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("createRuntimeSecretStore", () => {
  it("returns a SecretStore-shaped object outside production (development/test)", async () => {
    const { createRuntimeSecretStore } = await import("./runtime-secret-store.js");

    const store = createRuntimeSecretStore();

    expect(typeof store.put).toBe("function");
    expect(typeof store.get).toBe("function");
    expect(typeof store.delete).toBe("function");
  });

  it("throws ProductionSecretStoreNotConfiguredError under NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { createRuntimeSecretStore, ProductionSecretStoreNotConfiguredError } = await import(
      "./runtime-secret-store.js"
    );

    expect(() => createRuntimeSecretStore()).toThrow(ProductionSecretStoreNotConfiguredError);
  });

  it("never selects the local file store in production, even with DEV_SECRET_STORE_PATH set (section 29)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_SECRET_STORE_PATH", "/should/never/be/used.json");
    const { createRuntimeSecretStore, ProductionSecretStoreNotConfiguredError } = await import(
      "./runtime-secret-store.js"
    );

    expect(() => createRuntimeSecretStore()).toThrow(ProductionSecretStoreNotConfiguredError);
  });
});
