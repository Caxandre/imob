import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemorySecretStore } from "./in-memory-secret-store.js";

describe("createInMemorySecretStore", () => {
  it("round-trips a stored secret", async () => {
    const store = createInMemorySecretStore();
    const secret = { username: "tenant_app", password: "s3cr3t" };

    await store.put("tenant-databases/abc", secret);

    await expect(store.get("tenant-databases/abc")).resolves.toEqual(secret);
  });

  it("returns undefined for a key that was never stored", async () => {
    const store = createInMemorySecretStore();

    await expect(store.get("tenant-databases/missing")).resolves.toBeUndefined();
  });

  it("removes a secret on delete", async () => {
    const store = createInMemorySecretStore();
    await store.put("tenant-databases/abc", { username: "tenant_app", password: "s3cr3t" });

    await store.delete("tenant-databases/abc");

    await expect(store.get("tenant-databases/abc")).resolves.toBeUndefined();
  });

  it("deleting a key that was never stored is a no-op", async () => {
    const store = createInMemorySecretStore();

    await expect(store.delete("tenant-databases/never-existed")).resolves.toBeUndefined();
  });

  it("keeps secrets isolated per store instance", async () => {
    const storeA = createInMemorySecretStore();
    const storeB = createInMemorySecretStore();
    await storeA.put("tenant-databases/abc", { username: "a", password: "a" });

    await expect(storeB.get("tenant-databases/abc")).resolves.toBeUndefined();
  });

  it("overwrites an existing secret on a second put", async () => {
    const store = createInMemorySecretStore();
    await store.put("tenant-databases/abc", { username: "old", password: "old" });

    await store.put("tenant-databases/abc", { username: "new", password: "new" });

    await expect(store.get("tenant-databases/abc")).resolves.toEqual({
      username: "new",
      password: "new",
    });
  });

  it("stores whatever payload shape is given, unvalidated (boundary is untyped)", async () => {
    const store = createInMemorySecretStore();

    await store.put("clusters/primary", { unexpectedField: 123 });

    await expect(store.get("clusters/primary")).resolves.toEqual({ unexpectedField: 123 });
  });
});

describe("createInMemorySecretStore under NODE_ENV=production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to construct", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { createInMemorySecretStore: createInProdContext } = await import(
      "./in-memory-secret-store.js"
    );

    expect(() => createInProdContext()).toThrow(/NODE_ENV=production/);
  });
});
