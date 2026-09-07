import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestApp } from "./test-support/build-test-app.js";

/**
 * CORS is enforced by `@fastify/cors`, registered once inside `buildApp()` (Prompt 037C) — these
 * tests exercise it the same way a browser would, via `Fastify.inject()` with explicit
 * `Origin`/preflight headers. `/health` is enough to prove the simple-request behavior (section
 * 30 — no need to provision a real tenant just for that); the preflight tests specifically target
 * `/api/v1/properties` since that is the real Tenant Data Plane route that needs `X-Tenant-Id`
 * allowed. A preflight `OPTIONS` never reaches the route handler at all (`@fastify/cors` responds
 * directly), so none of these tests need a provisioned tenant even for `/api/v1/properties`.
 */

const apps: FastifyInstance[] = [];

function makeApp(corsAllowedOrigins: string[]): FastifyInstance {
  const app = buildTestApp(undefined, undefined, corsAllowedOrigins);
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

describe("CORS — simple requests", () => {
  it("adds Access-Control-Allow-Origin for a request from an allowed origin", async () => {
    const app = makeApp(["http://localhost:5173"]);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("does not add Access-Control-Allow-Origin for a disallowed origin", async () => {
    const app = makeApp(["http://localhost:5173"]);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example.com" },
    });

    // CORS is not authentication (section 17) — the request itself still succeeds server-side;
    // the browser is simply never told it may read the response.
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("matches origins exactly — a different port is not implicitly allowed", async () => {
    const app = makeApp(["http://localhost:5173"]);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:5174" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not block or otherwise alter a request with no Origin header", async () => {
    const app = makeApp(["http://localhost:5173"]);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("accepts a second, independently configured allowed origin", async () => {
    const app = makeApp(["http://localhost:5173", "http://127.0.0.1:5173"]);

    const first = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:5173" },
    });
    const second = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://127.0.0.1:5173" },
    });

    expect(first.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(second.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
  });

  it("never authorizes any browser origin when the allowlist is empty", async () => {
    const app = makeApp([]);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never sets Access-Control-Allow-Credentials (no cookie/session auth exists yet)", async () => {
    const app = makeApp(["http://localhost:5173"]);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("CORS — preflight (OPTIONS) on a real Tenant Data Plane route", () => {
  it("authorizes a GET preflight requesting the X-Tenant-Id header", async () => {
    const app = makeApp(["http://localhost:5173"]);

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/properties",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "X-Tenant-Id",
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers["access-control-allow-methods"]).toContain("GET");
    expect(String(response.headers["access-control-allow-headers"]).toLowerCase()).toContain(
      "x-tenant-id",
    );
  });

  it("authorizes a POST preflight requesting Content-Type and X-Tenant-Id together", async () => {
    const app = makeApp(["http://localhost:5173"]);

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/properties",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "Content-Type, X-Tenant-Id",
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    const allowedHeaders = String(response.headers["access-control-allow-headers"]).toLowerCase();
    expect(allowedHeaders).toContain("content-type");
    expect(allowedHeaders).toContain("x-tenant-id");
  });

  it("does not authorize a preflight from an unauthorized origin", async () => {
    const app = makeApp(["http://localhost:5173"]);

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/properties",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "X-Tenant-Id",
      },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
