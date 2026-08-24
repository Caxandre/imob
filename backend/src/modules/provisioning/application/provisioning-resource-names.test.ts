import { describe, expect, it } from "vitest";

import {
  buildProvisioningResourceNames,
  InvalidTenantIdError,
} from "./provisioning-resource-names.js";

const TENANT_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const TENANT_B = "9c858901-8a57-4791-81fe-4c455b099bc9";

describe("buildProvisioningResourceNames", () => {
  it("is deterministic for the same tenantId", () => {
    const first = buildProvisioningResourceNames(TENANT_A);
    const second = buildProvisioningResourceNames(TENANT_A);

    expect(first).toEqual(second);
  });

  it("produces different names for different tenants", () => {
    const a = buildProvisioningResourceNames(TENANT_A);
    const b = buildProvisioningResourceNames(TENANT_B);

    expect(a.databaseName).not.toBe(b.databaseName);
    expect(a.roleName).not.toBe(b.roleName);
    expect(a.secretReference).not.toBe(b.secretReference);
  });

  it("derives databaseName and roleName from the UUID without hyphens", () => {
    const names = buildProvisioningResourceNames(TENANT_A);

    expect(names.databaseName).toBe(`tenant_${TENANT_A.replaceAll("-", "")}`);
    expect(names.roleName).toBe(`${names.databaseName}_app`);
  });

  it("keeps the canonical hyphenated UUID in secretReference", () => {
    const names = buildProvisioningResourceNames(TENANT_A);

    expect(names.secretReference).toBe(`tenant-databases/${TENANT_A}`);
  });

  it("only uses lowercase letters, digits, and underscores in identifier names", () => {
    const names = buildProvisioningResourceNames(TENANT_A.toUpperCase());

    expect(names.databaseName).toMatch(/^[a-z0-9_]+$/);
    expect(names.roleName).toMatch(/^[a-z0-9_]+$/);
  });

  it("stays within the 63-byte PostgreSQL identifier limit", () => {
    const names = buildProvisioningResourceNames(TENANT_A);

    expect(Buffer.byteLength(names.databaseName, "utf8")).toBeLessThanOrEqual(63);
    expect(Buffer.byteLength(names.roleName, "utf8")).toBeLessThanOrEqual(63);
  });

  it("rejects a non-UUID tenantId", () => {
    expect(() => buildProvisioningResourceNames("not-a-uuid")).toThrow(InvalidTenantIdError);
  });

  it("rejects an empty tenantId", () => {
    expect(() => buildProvisioningResourceNames("")).toThrow(InvalidTenantIdError);
  });
});
