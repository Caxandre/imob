import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `env.ts` loads and validates `process.env` once at import time (`export const env =
 * loadEnv()`), so exercising different `CORS_ALLOWED_ORIGINS` values requires a fresh module
 * instance per test — `vi.resetModules()` + a dynamic `import()`, the same approach the
 * frontend's own `env.test.ts` uses. `vitest.config.ts` already sets every other required var
 * (`CONTROL_PLANE_DATABASE_URL`/`REDIS_URL`/`TENANT_DATABASE_DEFAULT_CLUSTER`) globally, so only
 * `CORS_ALLOWED_ORIGINS` needs stubbing per test here.
 *
 * `loadEnv()` calls `process.exit(1)` (not `throw`) on invalid config (Prompt 037C, section 37)
 * — actually exiting would kill the test runner, so `process.exit` is stubbed to throw instead,
 * which both proves it was called with `1` and stops module evaluation the same way a real exit
 * would.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("env — CORS_ALLOWED_ORIGINS", () => {
  it("defaults to an empty array when unset (no implicit wildcard)", async () => {
    const { env } = await import("./env.js");

    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it("defaults to an empty array when set to an empty string", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "");

    const { env } = await import("./env.js");

    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it("parses a single origin", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "http://localhost:5173");

    const { env } = await import("./env.js");

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:5173"]);
  });

  it("parses multiple comma-separated origins, trimming whitespace and dropping empty entries", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", " http://localhost:5173 , http://127.0.0.1:5173 ,, ");

    const { env } = await import("./env.js");

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
  });

  it("normalizes a trailing slash to the canonical origin", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "http://localhost:5173/");

    const { env } = await import("./env.js");

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:5173"]);
  });

  it("deduplicates repeated/equivalent origins", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:5173/,http://localhost:5173");

    const { env } = await import("./env.js");

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:5173"]);
  });

  it("treats http and https as distinct origins", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "http://localhost:5173,https://localhost:5173");

    const { env } = await import("./env.js");

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:5173", "https://localhost:5173"]);
  });

  it("fails fast on an entry with no protocol", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "localhost:5173");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit(1) called");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./env.js")).rejects.toThrow("process.exit(1) called");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fails fast on an entry that is not a URL at all", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "not-a-url");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit(1) called");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./env.js")).rejects.toThrow("process.exit(1) called");
  });

  it("fails fast on an entry with a path", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "http://localhost:5173/app");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit(1) called");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./env.js")).rejects.toThrow("process.exit(1) called");
  });

  it("fails fast on an entry with a query string", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "http://localhost:5173?x=1");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit(1) called");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./env.js")).rejects.toThrow("process.exit(1) called");
  });

  it("fails fast on a non-http(s) protocol", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "ftp://localhost:5173");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit(1) called");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./env.js")).rejects.toThrow("process.exit(1) called");
  });
});

describe("env — DEV_SECRET_STORE_PATH", () => {
  it("defaults to .local/secrets.json when unset", async () => {
    const { env } = await import("./env.js");

    expect(env.DEV_SECRET_STORE_PATH).toBe(".local/secrets.json");
  });

  it("accepts a custom relative path", async () => {
    vi.stubEnv("DEV_SECRET_STORE_PATH", ".local/custom-secrets.json");

    const { env } = await import("./env.js");

    expect(env.DEV_SECRET_STORE_PATH).toBe(".local/custom-secrets.json");
  });

  it("accepts a custom absolute path", async () => {
    vi.stubEnv("DEV_SECRET_STORE_PATH", "/tmp/imob-secrets.json");

    const { env } = await import("./env.js");

    expect(env.DEV_SECRET_STORE_PATH).toBe("/tmp/imob-secrets.json");
  });
});
