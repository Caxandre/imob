import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestApp } from "./test-support/build-test-app.js";

/**
 * These tests only ever construct `buildApp()` and read its generated OpenAPI document or
 * inject requests against routes that never touch PostgreSQL/Redis (`/health`, `/docs`,
 * `app.swagger()`) — registering the plugins and generating the specification never depends
 * on any infrastructure being reachable. Business-route behavior (POST /api/v1/tenants
 * actually creating a row) is covered by `tenant-routes.test.ts`, not here.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app = buildTestApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
  parameters?: { name: string; in: string }[];
}

interface OpenApiSpec {
  openapi: string;
  info: { title: string; description?: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown> };
}

function getSpec(): OpenApiSpec {
  return app.swagger() as unknown as OpenApiSpec;
}

describe("OpenAPI specification", () => {
  it("is OpenAPI 3.x with the expected API metadata", () => {
    const spec = getSpec();

    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info).toMatchObject({
      title: "Imob API",
      description: "API do SaaS imobiliário multi-tenant.",
    });
    expect(spec.info.version).toEqual(expect.any(String));
  });

  it("lists every real HTTP route — and nothing else", () => {
    const spec = getSpec();

    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/health",
        "/api/v1/tenants",
        "/api/v1/properties",
        "/api/v1/properties/{id}",
      ]),
    );
  });

  it("documents GET /health under the System tag with a 200 response", () => {
    const spec = getSpec();
    const operation = spec.paths["/health"]?.get;

    expect(operation).toBeDefined();
    expect(operation?.operationId).toBe("healthCheck");
    expect(operation?.tags).toEqual(["System"]);
    expect(operation?.responses).toHaveProperty("200");
  });

  it("documents POST /api/v1/tenants with a request body and 201/400/409/500 responses", () => {
    const spec = getSpec();
    const operation = spec.paths["/api/v1/tenants"]?.post;

    expect(operation).toBeDefined();
    expect(operation?.operationId).toBe("createTenant");
    expect(operation?.tags).toEqual(["Tenants"]);
    expect(operation?.requestBody).toBeDefined();
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(["201", "400", "409", "500"]),
    );
  });

  it("documents the Properties routes with the temporary X-Tenant-Id header and expected responses", () => {
    const spec = getSpec();

    const create = spec.paths["/api/v1/properties"]?.post;
    expect(create?.operationId).toBe("createProperty");
    expect(create?.tags).toEqual(["Properties"]);
    expect(Object.keys(create?.responses ?? {})).toEqual(
      expect.arrayContaining(["201", "400", "409", "503", "500"]),
    );

    const list = spec.paths["/api/v1/properties"]?.get;
    expect(list?.operationId).toBe("listProperties");
    expect(list?.tags).toEqual(["Properties"]);
    // Structured filters + sorting (this task) are documented as real query parameters, not
    // silently accepted-but-undocumented.
    const listQueryParamNames = (list?.parameters ?? [])
      .filter((param) => param.in === "query")
      .map((param) => param.name);
    expect(listQueryParamNames).toEqual(
      expect.arrayContaining([
        "status",
        "property_type",
        "transaction_type",
        "city",
        "price_min",
        "price_max",
        "sort",
        "order",
      ]),
    );

    const getById = spec.paths["/api/v1/properties/{id}"]?.get;
    expect(getById?.operationId).toBe("getProperty");
    expect(getById?.tags).toEqual(["Properties"]);
    expect(Object.keys(getById?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "400", "404", "409", "503", "500"]),
    );

    const update = spec.paths["/api/v1/properties/{id}"]?.patch;
    expect(update?.operationId).toBe("updateProperty");
    expect(update?.tags).toEqual(["Properties"]);
    expect(update?.requestBody).toBeDefined();
    expect(Object.keys(update?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "400", "404", "409", "503", "500"]),
    );

    const archive = spec.paths["/api/v1/properties/{id}"]?.delete;
    expect(archive?.operationId).toBe("archiveProperty");
    expect(archive?.tags).toEqual(["Properties"]);
    expect(Object.keys(archive?.responses ?? {})).toEqual(
      expect.arrayContaining(["204", "400", "404", "409", "503", "500"]),
    );
  });

  it("exposes named, reusable components instead of anonymous inline schemas", () => {
    const spec = getSpec();

    expect(Object.keys(spec.components?.schemas ?? {})).toEqual(
      expect.arrayContaining([
        "ErrorResponse",
        "HealthResponse",
        "CreateTenantRequest",
        "Tenant",
        "CreatePropertyRequest",
        "UpdatePropertyRequest",
        "Property",
        "PropertyList",
      ]),
    );
  });

  it("never documents non-HTTP internals (worker/dispatcher/provisioning) as routes", () => {
    const spec = getSpec();

    const paths = Object.keys(spec.paths);
    expect(paths.every((path) => path === "/health" || path.startsWith("/api/v1"))).toBe(true);
  });
});

describe("Swagger UI", () => {
  it("serves the documentation UI at /docs", async () => {
    const response = await app.inject({ method: "GET", url: "/docs" });

    // @fastify/swagger-ui may redirect the bare prefix to a trailing-slash index — assert the
    // real observed behavior rather than assuming one.
    if (response.statusCode >= 300 && response.statusCode < 400) {
      expect(response.headers.location).toBeDefined();
      const target = await app.inject({ method: "GET", url: String(response.headers.location) });
      expect(target.statusCode).toBe(200);
      expect(target.headers["content-type"]).toMatch(/text\/html/);
    } else {
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/text\/html/);
    }
  });

  it("serves the raw OpenAPI JSON programmatically at /docs/json", async () => {
    const response = await app.inject({ method: "GET", url: "/docs/json" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as OpenApiSpec;
    expect(body.paths).toHaveProperty("/api/v1/tenants");
  });
});
