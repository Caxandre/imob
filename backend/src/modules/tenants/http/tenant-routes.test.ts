import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestApp } from "../../../app/test-support/build-test-app.js";
import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  provisioningJobs,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import type { DatabaseClusterStatus, TenantDatabaseStatus } from "../domain/tenant-database-summary.js";
import type { TenantStatus } from "../domain/tenant.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let app: FastifyInstance;

async function createTenantRequest(body: Record<string, unknown>) {
  return await app.inject({ method: "POST", url: "/api/v1/tenants", payload: body });
}

async function listTenantsRequest(query = "") {
  return await app.inject({ method: "GET", url: `/api/v1/tenants${query}` });
}

async function getTenantDetailsRequest(id: string) {
  return await app.inject({ method: "GET", url: `/api/v1/tenants/${id}` });
}

async function insertTenant(
  overrides: Partial<{ name: string; slug: string; status: TenantStatus; createdAt: Date }> = {},
) {
  const createdAt = overrides.createdAt;
  const [row] = await controlPlaneDb
    .insert(tenants)
    .values({
      name: overrides.name ?? "Tenant",
      slug: overrides.slug ?? `tenant-${randomUUID()}`,
      status: overrides.status ?? "READY",
      ...(createdAt ? { createdAt, updatedAt: createdAt } : {}),
    })
    .returning();
  if (!row) throw new Error("tenant insert returned no row");
  return row;
}

async function insertCluster(
  overrides: Partial<{ name: string; status: DatabaseClusterStatus; provider: string; region: string }> = {},
) {
  const [row] = await controlPlaneDb
    .insert(databaseClusters)
    .values({
      name: overrides.name ?? `cluster-${randomUUID()}`,
      status: overrides.status ?? "ACTIVE",
      provider: overrides.provider ?? "local",
      region: overrides.region ?? "local",
      host: "localhost",
      port: 5432,
      secretReference: `clusters/${randomUUID()}`,
    })
    .returning();
  if (!row) throw new Error("database cluster insert returned no row");
  return row;
}

async function insertTenantDatabase(
  tenantId: string,
  clusterId: string,
  overrides: Partial<{ status: TenantDatabaseStatus; databaseName: string; schemaVersion: number }> = {},
) {
  const [row] = await controlPlaneDb
    .insert(tenantDatabases)
    .values({
      tenantId,
      clusterId,
      databaseName: overrides.databaseName ?? `tenant_${randomUUID().replace(/-/g, "_")}`,
      secretReference: `tenants/${tenantId}`,
      schemaVersion: overrides.schemaVersion ?? 0,
      status: overrides.status ?? "READY",
    })
    .returning();
  if (!row) throw new Error("tenant database insert returned no row");
  return row;
}

async function insertProvisioningJob(
  tenantId: string,
  overrides: Partial<{
    status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
    createdAt: Date;
    dispatchedAt: Date | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    errorMessage: string | null;
  }> = {},
) {
  const createdAt = overrides.createdAt;
  const [row] = await controlPlaneDb
    .insert(provisioningJobs)
    .values({
      tenantId,
      type: "CREATE_DATABASE",
      status: overrides.status ?? "PENDING",
      dispatchedAt: overrides.dispatchedAt ?? null,
      startedAt: overrides.startedAt ?? null,
      finishedAt: overrides.finishedAt ?? null,
      errorMessage: overrides.errorMessage ?? null,
      ...(createdAt ? { createdAt, updatedAt: createdAt } : {}),
    })
    .returning();
  if (!row) throw new Error("provisioning job insert returned no row");
  return row;
}

beforeEach(async () => {
  await controlPlaneDb.execute(
    sql`TRUNCATE TABLE ${provisioningJobs}, ${tenantDatabases}, ${tenants}, ${databaseClusters} CASCADE`,
  );
  app = buildTestApp();
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

  it("atomically persists exactly one provisioning job and no tenant database", async () => {
    await createTenantRequest({ name: "Acme", slug: "acme" });

    const jobs = await controlPlaneDb.select().from(provisioningJobs);
    const databases = await controlPlaneDb.select().from(tenantDatabases);

    expect(jobs).toHaveLength(1);
    expect(databases).toHaveLength(0);
  });

  it("associates the provisioning job with the created tenant", async () => {
    const response = await createTenantRequest({ name: "Acme", slug: "acme" });
    const { id: tenantId } = response.json();

    const [job] = await controlPlaneDb.select().from(provisioningJobs);

    expect(job?.tenantId).toBe(tenantId);
  });

  it("creates the provisioning job with the expected defaults", async () => {
    await createTenantRequest({ name: "Acme", slug: "acme" });

    const [job] = await controlPlaneDb.select().from(provisioningJobs);

    expect(job).toMatchObject({
      type: "CREATE_DATABASE",
      status: "PENDING",
      attempts: 0,
      currentStep: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      dispatchClaimedAt: null,
      dispatchLeaseUntil: null,
      dispatchedAt: null,
    });
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

  it("returns 409 when the slug already exists, without a leftover provisioning job", async () => {
    const first = await createTenantRequest({ name: "Primeira", slug: "duplicada" });
    expect(first.statusCode).toBe(201);

    const second = await createTenantRequest({ name: "Segunda", slug: "duplicada" });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ statusCode: 409, error: "Conflict" });

    const tenantRows = await controlPlaneDb.select().from(tenants);
    const jobRows = await controlPlaneDb.select().from(provisioningJobs);
    expect(tenantRows).toHaveLength(1);
    expect(jobRows).toHaveLength(1);
  });

  it("treats slugs differing only by case as duplicates", async () => {
    await createTenantRequest({ name: "Primeira", slug: "duplicada" });

    const second = await createTenantRequest({ name: "Segunda", slug: "DUPLICADA" });

    expect(second.statusCode).toBe(409);
  });
});

describe("POST /api/v1/tenants — transactional rollback", () => {
  const TRIGGER_NAME = "force_provisioning_job_failure";
  const FUNCTION_NAME = "force_provisioning_job_failure";

  afterEach(async () => {
    await controlPlaneDb.execute(
      sql.raw(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON provisioning_jobs`),
    );
    await controlPlaneDb.execute(sql.raw(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME}()`));
  });

  it("leaves no tenant or provisioning job behind when the job insert fails", async () => {
    // A real PostgreSQL trigger forces the second insert of the transaction to fail,
    // proving rollback against the actual database rather than a mocked Drizzle call.
    await controlPlaneDb.execute(sql.raw(`
      CREATE FUNCTION ${FUNCTION_NAME}() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced failure for rollback test';
      END;
      $$ LANGUAGE plpgsql
    `));
    await controlPlaneDb.execute(sql.raw(`
      CREATE TRIGGER ${TRIGGER_NAME}
      BEFORE INSERT ON provisioning_jobs
      FOR EACH ROW EXECUTE FUNCTION ${FUNCTION_NAME}()
    `));

    const response = await createTenantRequest({ name: "Rollback Test", slug: "rollback-test" });

    expect(response.statusCode).toBe(500);

    const tenantRows = await controlPlaneDb
      .select()
      .from(tenants)
      .where(eq(tenants.slug, "rollback-test"));
    const jobRows = await controlPlaneDb.select().from(provisioningJobs);

    expect(tenantRows).toHaveLength(0);
    expect(jobRows).toHaveLength(0);
  });
});

describe("GET /api/v1/tenants", () => {
  it("returns an empty list when there are no tenants (section 35)", async () => {
    const response = await listTenantsRequest();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, total_pages: 0 },
    });
  });

  it("returns a single tenant with no database (section 36/46)", async () => {
    const tenant = await insertTenant({ name: "Acme", slug: "acme", status: "PROVISIONING" });

    const response = await listTenantsRequest();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: tenant.id,
      name: "Acme",
      slug: "acme",
      status: "PROVISIONING",
      database: null,
    });
    expect(Date.parse(body.data[0].createdAt)).not.toBeNaN();
    expect(Date.parse(body.data[0].updatedAt)).not.toBeNaN();
  });

  it("orders multiple tenants by created_at DESC, id DESC (section 37)", async () => {
    const older = await insertTenant({ slug: "older", createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const newer = await insertTenant({ slug: "newer", createdAt: new Date("2026-01-02T00:00:00.000Z") });

    const response = await listTenantsRequest();

    const ids = response.json().data.map((t: { id: string }) => t.id);
    expect(ids).toEqual([newer.id, older.id]);
  });

  it("paginates results (section 38)", async () => {
    for (let i = 0; i < 25; i += 1) {
      await insertTenant({ slug: `tenant-${String(i).padStart(2, "0")}` });
    }

    const page1 = await listTenantsRequest("?page=1&limit=20");
    const page2 = await listTenantsRequest("?page=2&limit=20");

    expect(page1.json().data).toHaveLength(20);
    expect(page1.json().pagination).toEqual({ page: 1, limit: 20, total: 25, total_pages: 2 });
    expect(page2.json().data).toHaveLength(5);
    expect(page2.json().pagination).toEqual({ page: 2, limit: 20, total: 25, total_pages: 2 });

    const page1Ids = new Set(page1.json().data.map((t: { id: string }) => t.id));
    const page2Ids = new Set(page2.json().data.map((t: { id: string }) => t.id));
    expect(page1Ids.size + page2Ids.size).toBe(25);
    for (const id of page2Ids) expect(page1Ids.has(id)).toBe(false);
  });

  it("finds by name via q (section 39)", async () => {
    await insertTenant({ name: "Imobiliária Central", slug: "central" });
    await insertTenant({ name: "Outra Empresa", slug: "outra" });

    const response = await listTenantsRequest("?q=Central");

    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].slug).toBe("central");
  });

  it("finds by slug via q (section 40)", async () => {
    await insertTenant({ name: "Imobiliária Central", slug: "imobiliaria-central" });
    await insertTenant({ name: "Outra Empresa", slug: "outra-empresa" });

    const response = await listTenantsRequest("?q=imobiliaria-central");

    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].slug).toBe("imobiliaria-central");
  });

  it("matches q case-insensitively (section 42)", async () => {
    await insertTenant({ name: "Imobiliaria Central", slug: "central" });

    const response = await listTenantsRequest("?q=IMOBILIARIA");

    expect(response.json().data).toHaveLength(1);
  });

  it.each(["PROVISIONING", "READY", "FAILED", "SUSPENDED"] as const)(
    "filters by status=%s (section 43)",
    async (status) => {
      await insertTenant({ slug: "match", status });
      await insertTenant({ slug: "no-match", status: status === "READY" ? "FAILED" : "READY" });

      const response = await listTenantsRequest(`?status=${status}`);

      expect(response.json().data).toHaveLength(1);
      expect(response.json().data[0].slug).toBe("match");
    },
  );

  it("combines q and status with AND (section 44)", async () => {
    await insertTenant({ name: "Imobiliária Central", slug: "central-ready", status: "READY" });
    await insertTenant({ name: "Imobiliária Central", slug: "central-failed", status: "FAILED" });
    await insertTenant({ name: "Outra Empresa", slug: "outra-ready", status: "READY" });

    const response = await listTenantsRequest("?q=Central&status=READY");

    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].slug).toBe("central-ready");
  });

  it("returns database and cluster summary for a tenant with a registered database (section 45)", async () => {
    const cluster = await insertCluster({ name: "local-tenants", provider: "local", region: "local" });
    const tenant = await insertTenant({ slug: "with-db", status: "READY" });
    await insertTenantDatabase(tenant.id, cluster.id, {
      databaseName: "tenant_with_db",
      schemaVersion: 7,
      status: "READY",
    });

    const response = await listTenantsRequest();

    expect(response.json().data[0].database).toEqual({
      status: "READY",
      databaseName: "tenant_with_db",
      schemaVersion: 7,
      cluster: {
        id: cluster.id,
        name: "local-tenants",
        provider: "local",
        region: "local",
        status: "ACTIVE",
      },
    });
  });

  it("never includes secret_reference/password/credential in the response (section 47)", async () => {
    const cluster = await insertCluster();
    const tenant = await insertTenant({ slug: "secrets-check" });
    await insertTenantDatabase(tenant.id, cluster.id);

    const response = await listTenantsRequest();
    const raw = JSON.stringify(response.json());

    expect(raw).not.toContain("secret_reference");
    expect(raw).not.toContain("secretReference");
    expect(raw.toLowerCase()).not.toContain("password");
    expect(raw.toLowerCase()).not.toContain("credential");
  });

  it.each([
    ["page=0", "?page=0"],
    ["page=-1", "?page=-1"],
    ["limit=0", "?limit=0"],
    ["limit=101", "?limit=101"],
  ])("rejects invalid pagination (%s) with 400 (section 48)", async (_label, query) => {
    const response = await listTenantsRequest(query);

    expect(response.statusCode).toBe(400);
  });

  it("rejects an invalid status with 400 (section 49)", async () => {
    const response = await listTenantsRequest("?status=UNKNOWN");

    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown query parameter with 400 (section 50)", async () => {
    const response = await listTenantsRequest("?unknown=value");

    expect(response.statusCode).toBe(400);
  });

  it("rejects q that is empty after trim with 400", async () => {
    const response = await listTenantsRequest("?q=%20%20");

    expect(response.statusCode).toBe(400);
  });

  it("uses id as a deterministic tie-breaker when created_at is equal (section 51)", async () => {
    const sameInstant = new Date("2026-01-01T00:00:00.000Z");
    const first = await insertTenant({ slug: "tie-a", createdAt: sameInstant });
    const second = await insertTenant({ slug: "tie-b", createdAt: sameInstant });

    const page1 = await listTenantsRequest("?page=1&limit=1");
    const page2 = await listTenantsRequest("?page=2&limit=1");

    const expectedOrder = [first.id, second.id].sort().reverse();
    expect(page1.json().data[0].id).toBe(expectedOrder[0]);
    expect(page2.json().data[0].id).toBe(expectedOrder[1]);
  });
});

describe("GET /api/v1/tenants/:id", () => {
  it("rejects an invalid id with 400 (section 27)", async () => {
    const response = await getTenantDetailsRequest("not-a-uuid");

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for a well-formed but non-existent id (section 28)", async () => {
    const response = await getTenantDetailsRequest("11111111-1111-4111-8111-111111111111");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
  });

  it("returns a basic tenant with database:null and latestProvisioningJob:null (section 29)", async () => {
    const tenant = await insertTenant({ name: "Acme", slug: "acme", status: "PROVISIONING" });

    const response = await getTenantDetailsRequest(tenant.id);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: tenant.id,
      name: "Acme",
      slug: "acme",
      status: "PROVISIONING",
      database: null,
      latestProvisioningJob: null,
    });
    expect(Date.parse(body.createdAt)).not.toBeNaN();
    expect(Date.parse(body.updatedAt)).not.toBeNaN();
  });

  it("returns database fields (section 30)", async () => {
    const cluster = await insertCluster();
    const tenant = await insertTenant({ slug: "with-db", status: "READY" });
    const database = await insertTenantDatabase(tenant.id, cluster.id, {
      databaseName: "tenant_with_db",
      schemaVersion: 7,
      status: "READY",
    });

    const response = await getTenantDetailsRequest(tenant.id);
    const body = response.json();

    expect(body.database).toMatchObject({
      status: "READY",
      databaseName: "tenant_with_db",
      schemaVersion: 7,
    });
    expect(Date.parse(body.database.createdAt)).toBe(database.createdAt.getTime());
    expect(Date.parse(body.database.updatedAt)).toBe(database.updatedAt.getTime());
  });

  it("returns cluster fields (section 31)", async () => {
    const cluster = await insertCluster({ name: "local-tenants", provider: "local", region: "local" });
    const tenant = await insertTenant({ slug: "with-cluster" });
    await insertTenantDatabase(tenant.id, cluster.id);

    const response = await getTenantDetailsRequest(tenant.id);

    expect(response.json().database.cluster).toEqual({
      id: cluster.id,
      name: "local-tenants",
      provider: "local",
      region: "local",
      status: "ACTIVE",
    });
  });

  it("returns only the latest provisioning job by created_at DESC, id DESC (section 32)", async () => {
    const tenant = await insertTenant({ slug: "multi-job" });
    await insertProvisioningJob(tenant.id, {
      status: "FAILED",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      errorMessage: "first attempt failed",
    });
    const latest = await insertProvisioningJob(tenant.id, {
      status: "SUCCEEDED",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      dispatchedAt: new Date("2026-01-02T00:00:05.000Z"),
      startedAt: new Date("2026-01-02T00:00:06.000Z"),
      finishedAt: new Date("2026-01-02T00:05:00.000Z"),
    });

    const response = await getTenantDetailsRequest(tenant.id);
    const job = response.json().latestProvisioningJob;

    expect(job).toMatchObject({
      id: latest.id,
      type: "CREATE_DATABASE",
      status: "SUCCEEDED",
      errorMessage: null,
    });
    expect(Date.parse(job.dispatchedAt)).toBe(latest.dispatchedAt?.getTime());
    expect(Date.parse(job.startedAt)).toBe(latest.startedAt?.getTime());
    expect(Date.parse(job.finishedAt)).toBe(latest.finishedAt?.getTime());
  });

  it("uses id as a deterministic tie-breaker for the latest job when created_at is equal (section 33)", async () => {
    const tenant = await insertTenant({ slug: "tie-job" });
    const sameInstant = new Date("2026-01-01T00:00:00.000Z");
    const first = await insertProvisioningJob(tenant.id, { createdAt: sameInstant });
    const second = await insertProvisioningJob(tenant.id, { createdAt: sameInstant });

    const response = await getTenantDetailsRequest(tenant.id);

    const expectedLatestId = [first.id, second.id].sort().reverse()[0];
    expect(response.json().latestProvisioningJob.id).toBe(expectedLatestId);
  });

  it.each(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"] as const)(
    "surfaces a provisioning job with status=%s (section 34)",
    async (status) => {
      const tenant = await insertTenant({ slug: `job-status-${status.toLowerCase()}` });
      await insertProvisioningJob(tenant.id, { status });

      const response = await getTenantDetailsRequest(tenant.id);

      expect(response.json().latestProvisioningJob.status).toBe(status);
    },
  );

  it("never includes secret_reference/host/port/password/credential in the response (section 35)", async () => {
    const cluster = await insertCluster();
    const tenant = await insertTenant({ slug: "secrets-check" });
    await insertTenantDatabase(tenant.id, cluster.id);
    await insertProvisioningJob(tenant.id);

    const response = await getTenantDetailsRequest(tenant.id);
    const raw = JSON.stringify(response.json());

    expect(raw).not.toContain("secret_reference");
    expect(raw).not.toContain("secretReference");
    expect(raw.toLowerCase()).not.toContain("password");
    expect(raw.toLowerCase()).not.toContain("credential");
    expect(raw).not.toContain("localhost");
    expect(raw).not.toMatch(/"host"/);
    expect(raw).not.toMatch(/"port"/);
  });
});
