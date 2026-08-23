import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../../app/build-app.js";
import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import {
  provisioningJobs,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let app: FastifyInstance;

async function createTenantRequest(body: Record<string, unknown>) {
  return await app.inject({ method: "POST", url: "/api/v1/tenants", payload: body });
}

beforeEach(async () => {
  await controlPlaneDb.execute(
    sql`TRUNCATE TABLE ${provisioningJobs}, ${tenantDatabases}, ${tenants} CASCADE`,
  );
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await controlPlanePool.end();
});

describe("POST /api/v1/tenants", () => {
  it("creates a tenant and returns 201", async () => {
    const response = await createTenantRequest({
      name: "Imobiliária Exemplo",
      slug: "imobiliaria-exemplo",
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.id).toMatch(UUID_PATTERN);
    expect(body.name).toBe("Imobiliária Exemplo");
    expect(body.slug).toBe("imobiliaria-exemplo");
    expect(body.status).toBe("PROVISIONING");
    expect(Date.parse(body.createdAt)).not.toBeNaN();
    expect(Date.parse(body.updatedAt)).not.toBeNaN();
  });

  it("persists the tenant in the Control Plane", async () => {
    const response = await createTenantRequest({ name: "Acme", slug: "acme" });
    const { id } = response.json();

    const rows = await controlPlaneDb.select().from(tenants).where(eq(tenants.id, id));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, name: "Acme", slug: "acme", status: "PROVISIONING" });
  });

  it("does not create any provisioning job", async () => {
    await createTenantRequest({ name: "Acme", slug: "acme" });

    const jobs = await controlPlaneDb.select().from(provisioningJobs);
    const databases = await controlPlaneDb.select().from(tenantDatabases);

    expect(jobs).toHaveLength(0);
    expect(databases).toHaveLength(0);
  });

  it("trims the name and trims/lowercases the slug", async () => {
    const response = await createTenantRequest({
      name: "  Imobiliária Exemplo  ",
      slug: "  EMPRESA-EXEMPLO  ",
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: "Imobiliária Exemplo",
      slug: "empresa-exemplo",
    });

    const [persisted] = await controlPlaneDb.select().from(tenants);
    expect(persisted).toMatchObject({ name: "Imobiliária Exemplo", slug: "empresa-exemplo" });
  });

  it("rejects a name that is empty after trimming", async () => {
    const response = await createTenantRequest({ name: "   ", slug: "valid-slug" });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Bad Request");
  });

  it.each([
    ["space", "imobiliaria exemplo"],
    ["underscore", "imobiliaria_exemplo"],
    ["trailing underscore", "imobiliaria_"],
    ["leading hyphen", "-imobiliaria"],
    ["trailing hyphen", "imobiliaria-"],
    ["consecutive hyphens", "imobiliaria--exemplo"],
    ["accented character", "imobiliária"],
    ["too short", "ab"],
  ])("rejects an invalid slug (%s)", async (_label, slug) => {
    const response = await createTenantRequest({ name: "Valid Name", slug });

    expect(response.statusCode).toBe(400);
    expect(response.json().details.some((d: { path: string }) => d.path === "slug")).toBe(true);
  });

  it("rejects a payload with missing fields", async () => {
    const response = await createTenantRequest({});

    expect(response.statusCode).toBe(400);
  });

  it("returns 409 when the slug already exists", async () => {
    const first = await createTenantRequest({ name: "Primeira", slug: "duplicada" });
    expect(first.statusCode).toBe(201);

    const second = await createTenantRequest({ name: "Segunda", slug: "duplicada" });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ statusCode: 409, error: "Conflict" });

    const rows = await controlPlaneDb.select().from(tenants);
    expect(rows).toHaveLength(1);
  });

  it("treats slugs differing only by case as duplicates", async () => {
    await createTenantRequest({ name: "Primeira", slug: "duplicada" });

    const second = await createTenantRequest({ name: "Segunda", slug: "DUPLICADA" });

    expect(second.statusCode).toBe(409);
  });
});
