import { describe, expect, it } from "vitest";

import { createTenantDatabaseCredential } from "./tenant-database-credential-generator.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

describe("createTenantDatabaseCredential", () => {
  it("uses the given roleName as username, unchanged", () => {
    const roleName = "tenant_3fa85f6457174562b3fc2c963f66afa6_app";

    const credential = createTenantDatabaseCredential(roleName);

    expect(credential.username).toBe(roleName);
  });

  it("generates a non-empty password", () => {
    const credential = createTenantDatabaseCredential("tenant_app");

    expect(credential.password.length).toBeGreaterThan(0);
  });

  it("generates a different password on every call, for the same role", () => {
    const first = createTenantDatabaseCredential("tenant_app");
    const second = createTenantDatabaseCredential("tenant_app");

    expect(first.password).not.toBe(second.password);
  });

  it("generates a different password for different roles", () => {
    const a = createTenantDatabaseCredential("tenant_a_app");
    const b = createTenantDatabaseCredential("tenant_b_app");

    expect(a.password).not.toBe(b.password);
  });

  it("encodes the password as base64url (no +, /, or = padding)", () => {
    const credential = createTenantDatabaseCredential("tenant_app");

    expect(credential.password).toMatch(BASE64URL_PATTERN);
  });

  it("carries at least 256 bits of entropy (32 random bytes, base64url-encoded)", () => {
    const credential = createTenantDatabaseCredential("tenant_app");

    // 32 raw bytes encode to 43 base64url characters (ceil(32 * 8 / 6), no padding).
    expect(credential.password.length).toBe(43);
  });
});
