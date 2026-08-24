import { describe, expect, it } from "vitest";

import {
  ClusterAdminSecretNotFoundError,
  createClusterAdminCredentialResolver,
  InvalidClusterAdminSecretError,
} from "./cluster-admin-credential-resolver.js";
import { createInMemorySecretStore } from "../test-support/in-memory-secret-store.js";

describe("createClusterAdminCredentialResolver", () => {
  it("returns the validated credential for a valid secret", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("clusters/primary", { username: "admin", password: "s3cr3t" });
    const resolver = createClusterAdminCredentialResolver(secretStore);

    const credential = await resolver.resolve("clusters/primary");

    expect(credential).toEqual({ username: "admin", password: "s3cr3t" });
  });

  it("throws ClusterAdminSecretNotFoundError when nothing is stored at the reference", async () => {
    const secretStore = createInMemorySecretStore();
    const resolver = createClusterAdminCredentialResolver(secretStore);

    await expect(resolver.resolve("clusters/missing")).rejects.toThrow(
      ClusterAdminSecretNotFoundError,
    );
  });

  it("throws InvalidClusterAdminSecretError when the stored value is not an object", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("clusters/broken", "just-a-string");
    const resolver = createClusterAdminCredentialResolver(secretStore);

    await expect(resolver.resolve("clusters/broken")).rejects.toThrow(
      InvalidClusterAdminSecretError,
    );
  });

  it("throws InvalidClusterAdminSecretError when password is missing", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("clusters/no-password", { username: "admin" });
    const resolver = createClusterAdminCredentialResolver(secretStore);

    await expect(resolver.resolve("clusters/no-password")).rejects.toThrow(
      InvalidClusterAdminSecretError,
    );
  });

  it("throws InvalidClusterAdminSecretError when username is missing", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("clusters/no-username", { password: "s3cr3t" });
    const resolver = createClusterAdminCredentialResolver(secretStore);

    await expect(resolver.resolve("clusters/no-username")).rejects.toThrow(
      InvalidClusterAdminSecretError,
    );
  });

  it("throws InvalidClusterAdminSecretError when the payload has unexpected extra fields", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("clusters/extra-field", {
      username: "admin",
      password: "s3cr3t",
      host: "internal-cluster.example.com",
    });
    const resolver = createClusterAdminCredentialResolver(secretStore);

    await expect(resolver.resolve("clusters/extra-field")).rejects.toThrow(
      InvalidClusterAdminSecretError,
    );
  });

  it("never leaks the stored password into the not-found error message", async () => {
    const secretStore = createInMemorySecretStore();
    const resolver = createClusterAdminCredentialResolver(secretStore);

    await expect(resolver.resolve("clusters/missing")).rejects.toThrow(
      'No cluster admin secret found at reference "clusters/missing"',
    );
  });

  it("never leaks the stored username/password into the invalid-secret error message", async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.put("clusters/broken", { username: "produser", password: 12345 });
    const resolver = createClusterAdminCredentialResolver(secretStore);

    let caughtError: Error | undefined;
    try {
      await resolver.resolve("clusters/broken");
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).toBeInstanceOf(InvalidClusterAdminSecretError);
    expect(caughtError?.message).not.toContain("12345");
    expect(caughtError?.message).not.toContain("produser");
  });
});
