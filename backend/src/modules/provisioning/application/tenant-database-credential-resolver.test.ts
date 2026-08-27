import { describe, expect, it } from "vitest";

import { createInMemorySecretStore } from "../test-support/in-memory-secret-store.js";
import { InvalidTenantSecretError } from "./tenant-role-provisioner.js";
import {
  createTenantDatabaseCredentialResolver,
  TenantSecretNotFoundError,
} from "./tenant-database-credential-resolver.js";

describe("createTenantDatabaseCredentialResolver", () => {
  it("returns the validated credential for a valid secret", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("tenant-databases/t1", { username: "tenant_t1_app", password: "s3cr3t" });
    const resolver = createTenantDatabaseCredentialResolver(secretStore);

    const credential = await resolver.resolve("tenant-databases/t1");

    expect(credential).toEqual({ username: "tenant_t1_app", password: "s3cr3t" });
  });

  it("throws TenantSecretNotFoundError when nothing is stored at the reference", async () => {
    const secretStore = createInMemorySecretStore();
    const resolver = createTenantDatabaseCredentialResolver(secretStore);

    await expect(resolver.resolve("tenant-databases/missing")).rejects.toThrow(
      TenantSecretNotFoundError,
    );
  });

  it("throws InvalidTenantSecretError when the stored value is not an object", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("tenant-databases/broken", "just-a-string");
    const resolver = createTenantDatabaseCredentialResolver(secretStore);

    await expect(resolver.resolve("tenant-databases/broken")).rejects.toThrow(InvalidTenantSecretError);
  });

  it("throws InvalidTenantSecretError when password is missing", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("tenant-databases/no-password", { username: "tenant_t1_app" });
    const resolver = createTenantDatabaseCredentialResolver(secretStore);

    await expect(resolver.resolve("tenant-databases/no-password")).rejects.toThrow(
      InvalidTenantSecretError,
    );
  });

  it("throws InvalidTenantSecretError when the payload has unexpected extra fields", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("tenant-databases/extra-field", {
      username: "tenant_t1_app",
      password: "s3cr3t",
      host: "internal-cluster.example.com",
    });
    const resolver = createTenantDatabaseCredentialResolver(secretStore);

    await expect(resolver.resolve("tenant-databases/extra-field")).rejects.toThrow(
      InvalidTenantSecretError,
    );
  });

  it("never leaks the stored password into the not-found error message", async () => {
    const secretStore = createInMemorySecretStore();
    const resolver = createTenantDatabaseCredentialResolver(secretStore);

    await expect(resolver.resolve("tenant-databases/missing")).rejects.toThrow(
      'No tenant database secret found at reference "tenant-databases/missing"',
    );
  });

  it("never leaks the stored username/password into the invalid-secret error message", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("tenant-databases/broken", { username: "tenant_t1_app", password: 12345 });
    const resolver = createTenantDatabaseCredentialResolver(secretStore);

    let caughtError: Error | undefined;
    try {
      await resolver.resolve("tenant-databases/broken");
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).toBeInstanceOf(InvalidTenantSecretError);
    expect(caughtError?.message).not.toContain("12345");
    expect(caughtError?.message).not.toContain("tenant_t1_app");
  });
});
