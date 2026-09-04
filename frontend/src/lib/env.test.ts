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
});
