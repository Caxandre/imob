import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("env", () => {
  it("exposes a validated apiUrl from VITE_API_URL", async () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:3000");

    const { env } = await import("./env");

    expect(env.apiUrl).toBe("http://localhost:3000");
  });

  it("throws at import time when VITE_API_URL is not a valid URL", async () => {
    vi.stubEnv("VITE_API_URL", "not-a-url");

    await expect(import("./env")).rejects.toThrow(/VITE_API_URL/);
  });

  it("exposes tenantId as undefined when VITE_TENANT_ID is unset", async () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:3000");
    vi.stubEnv("VITE_TENANT_ID", "");

    const { env } = await import("./env");

    expect(env.tenantId).toBeUndefined();
  });

  it("exposes a validated tenantId from VITE_TENANT_ID", async () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:3000");
    vi.stubEnv("VITE_TENANT_ID", "3fa85f64-5717-4562-b3fc-2c963f66afa6");

    const { env } = await import("./env");

    expect(env.tenantId).toBe("3fa85f64-5717-4562-b3fc-2c963f66afa6");
  });

  it("throws at import time when VITE_TENANT_ID is not a valid UUID", async () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:3000");
    vi.stubEnv("VITE_TENANT_ID", "not-a-uuid");

    await expect(import("./env")).rejects.toThrow(/VITE_TENANT_ID/);
  });

  it("requireTenantId returns the tenant id when configured", async () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:3000");
    vi.stubEnv("VITE_TENANT_ID", "3fa85f64-5717-4562-b3fc-2c963f66afa6");

    const { requireTenantId } = await import("./env");

    expect(requireTenantId()).toBe("3fa85f64-5717-4562-b3fc-2c963f66afa6");
  });

  it("requireTenantId throws when the tenant id is not configured", async () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:3000");
    vi.stubEnv("VITE_TENANT_ID", "");

    const { requireTenantId } = await import("./env");

    expect(() => requireTenantId()).toThrow(/VITE_TENANT_ID/);
  });
});
