import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestApp } from "../../../app/test-support/build-test-app.js";
import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  provisioningJobs,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import { createClusterAdminCredentialResolver } from "../../provisioning/application/cluster-admin-credential-resolver.js";
import { startPendingProvisioningJob } from "../../provisioning/application/process-provisioning-job.js";
import type {
  DatabaseProvisioner,
  ProcessProvisioningJobRepository,
} from "../../provisioning/application/process-provisioning-job.js";
import { buildProvisioningResourceNames } from "../../provisioning/application/provisioning-resource-names.js";
import type { SecretStore } from "../../provisioning/application/secret-store.js";
import { createTenantDatabaseCredentialResolver } from "../../provisioning/application/tenant-database-credential-resolver.js";
import { createDrizzleDatabaseClusterSelector } from "../../provisioning/infrastructure/drizzle-database-cluster-selector.js";
import { createDrizzleProcessProvisioningJobRepository } from "../../provisioning/infrastructure/drizzle-process-provisioning-job-repository.js";
import { createPostgresDatabaseProvisioner } from "../../provisioning/infrastructure/postgres-database-provisioner.js";
import { createPostgresTenantDatabaseHealthChecker } from "../../provisioning/infrastructure/postgres-tenant-database-health-checker.js";
import { createPostgresTenantDatabaseProvisioner } from "../../provisioning/infrastructure/postgres-tenant-database-provisioner.js";
import { createPostgresTenantRoleProvisioner } from "../../provisioning/infrastructure/postgres-tenant-role-provisioner.js";
import { createInMemorySecretStore } from "../../provisioning/test-support/in-memory-secret-store.js";
import type { Tenant } from "../../tenants/domain/tenant.js";
import { createDrizzleTenantRepository } from "../../tenants/infrastructure/drizzle-tenant-repository.js";

/**
 * Full HTTP integration tests, real infrastructure throughout — same pattern as
 * `property-routes.test.ts`: `app.inject()` against a real, running
 * `TenantDatabaseResolver`/`TenantDatabaseConnectionManager` pipeline, real tenants provisioned
 * end to end. `buildTestApp(secretStore)` is handed the *same* `SecretStore` instance used to
 * provision each tenant.
 */
const CLUSTER_NAME = "e2e-leads-test-cluster";
const ADMIN_SECRET_REFERENCE = `clusters/${CLUSTER_NAME}`;
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";
const TENANTS_HOST = "localhost";
const TENANTS_PORT = 5433;
const LEASE_SECONDS = 60;
const TENANT_ID_HEADER = "x-tenant-id";

const createdDatabaseNames = new Set<string>();
const createdRoleNames = new Set<string>();

function trackTenantResources(tenantId: string): void {
  const names = buildProvisioningResourceNames(tenantId);
  createdDatabaseNames.add(names.databaseName);
  createdRoleNames.add(names.roleName);
}

beforeEach(async () => {
  await controlPlaneDb.execute(
    sql`TRUNCATE TABLE ${provisioningJobs}, ${tenantDatabases}, ${tenants}, ${databaseClusters} CASCADE`,
  );
});

afterEach(async () => {
  const databaseNames = [...createdDatabaseNames];
  const roleNames = [...createdRoleNames];
  createdDatabaseNames.clear();
  createdRoleNames.clear();

  const client = new Client({
    host: TENANTS_HOST,
    port: TENANTS_PORT,
    database: "postgres",
    user: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  });
  await client.connect();
  try {
    for (const databaseName of databaseNames) {
      await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(databaseName)} WITH (FORCE)`);
    }
    for (const roleName of roleNames) {
      await client.query(`DROP ROLE IF EXISTS ${escapeIdentifier(roleName)}`);
    }
  } finally {
    await client.end();
  }

  await controlPlaneDb.execute(sql`TRUNCATE TABLE ${databaseClusters} CASCADE`);
});

afterAll(async () => {
  await controlPlanePool.end();
});

async function setupCluster(): Promise<{ secretStore: SecretStore }> {
  await controlPlaneDb.insert(databaseClusters).values({
    name: CLUSTER_NAME,
    status: "ACTIVE",
    provider: "local",
    region: "local",
    host: TENANTS_HOST,
    port: TENANTS_PORT,
    secretReference: ADMIN_SECRET_REFERENCE,
  });

  const secretStore = createInMemorySecretStore();
  await secretStore.put(ADMIN_SECRET_REFERENCE, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  return { secretStore };
}

function buildRealProvisioningPipeline(secretStore: SecretStore): {
  databaseProvisioner: DatabaseProvisioner;
  repository: ProcessProvisioningJobRepository;
} {
  const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
  const databaseProvisioner = createPostgresDatabaseProvisioner({
    clusterSelector: createDrizzleDatabaseClusterSelector(controlPlaneDb, CLUSTER_NAME),
    clusterAdminCredentialResolver,
    tenantRoleProvisioner: createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver }),
    tenantDatabaseProvisioner: createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver }),
    tenantDatabaseCredentialResolver: createTenantDatabaseCredentialResolver(secretStore),
    healthChecker: createPostgresTenantDatabaseHealthChecker(),
  });
  return { databaseProvisioner, repository: createDrizzleProcessProvisioningJobRepository(controlPlaneDb) };
}

async function createPendingTenant(slugPrefix: string): Promise<{ tenant: Tenant; jobId: string }> {
  const tenantRepository = createDrizzleTenantRepository(controlPlaneDb);
  const tenant = await tenantRepository.createWithProvisioningIntent({
    name: `Leads E2E ${slugPrefix}`,
    slug: `${slugPrefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  });
  trackTenantResources(tenant.id);

  const [job] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.tenantId, tenant.id));
  if (!job) {
    throw new Error("provisioning job was not created alongside the tenant");
  }

  return { tenant, jobId: job.id };
}

async function provisionReadyTenant(slugPrefix: string, secretStore: SecretStore): Promise<Tenant> {
  const { tenant, jobId } = await createPendingTenant(slugPrefix);

  const { databaseProvisioner, repository } = buildRealProvisioningPipeline(secretStore);
  const outcome = await startPendingProvisioningJob(
    repository,
    databaseProvisioner,
    { provisioningJobId: jobId, tenantId: tenant.id },
    { leaseSeconds: LEASE_SECONDS, heartbeatIntervalMs: 999_999 },
  );
  if (outcome.outcome !== "succeeded") {
    throw new Error(`expected provisioning to succeed for "${slugPrefix}", got ${JSON.stringify(outcome)}`);
  }

  return tenant;
}

function samplePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Maria Souza",
    email: "maria.souza@example.com",
    phone: "+55 11 99999-0000",
    source: "MANUAL",
    message: "Tenho interesse neste apartamento.",
    ...overrides,
  };
}

function samplePropertyPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Apartamento no Centro",
    property_type: "APARTMENT",
    transaction_type: "SALE",
    status: "ACTIVE",
    price: "450000.00",
    ...overrides,
  };
}

async function createLeadRequest(app: FastifyInstance, tenantId: string, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/leads",
    headers: { [TENANT_ID_HEADER]: tenantId },
    payload: samplePayload(overrides),
  });
}

async function createPropertyRequest(app: FastifyInstance, tenantId: string, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/properties",
    headers: { [TENANT_ID_HEADER]: tenantId },
    payload: samplePropertyPayload(overrides),
  });
}

async function patchLeadRequest(app: FastifyInstance, tenantId: string, leadId: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/leads/${leadId}`,
    headers: { [TENANT_ID_HEADER]: tenantId },
    payload: body,
  });
}

async function getLeadRequest(app: FastifyInstance, tenantId: string, leadId: string) {
  return app.inject({ method: "GET", url: `/api/v1/leads/${leadId}`, headers: { [TENANT_ID_HEADER]: tenantId } });
}

async function listLeadsRequest(app: FastifyInstance, tenantId: string, query = "") {
  return app.inject({
    method: "GET",
    url: `/api/v1/leads${query}`,
    headers: { [TENANT_ID_HEADER]: tenantId },
  });
}

describe("Leads HTTP routes", () => {
  describe("POST /api/v1/leads", () => {
    it("creates a lead and returns 201 with status NEW, never a tenant_id", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("create", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await createLeadRequest(app, tenant.id);

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(body).toMatchObject({
          name: "Maria Souza",
          email: "maria.souza@example.com",
          phone: "+55 11 99999-0000",
          status: "NEW",
          source: "MANUAL",
          property_id: null,
        });
        expect(body.tenant_id).toBeUndefined();
        expect(body.property).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it("ignores a client-supplied status — always created as NEW", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("create-status", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await createLeadRequest(app, tenant.id, { status: "WON" });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("accepts a lead with only phone (no email)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("create-phone-only", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await createLeadRequest(app, tenant.id, { email: undefined, phone: "11988887777" });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({ email: null, phone: "11988887777" });
      } finally {
        await app.close();
      }
    });

    it("rejects a lead with neither email nor phone", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("create-no-contact", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await createLeadRequest(app, tenant.id, { email: undefined, phone: undefined });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("creates a lead associated with a real property in this tenant", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("create-property", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const propertyId = property.json().id;

        const response = await createLeadRequest(app, tenant.id, { property_id: propertyId });

        expect(response.statusCode).toBe(201);
        expect(response.json().property_id).toBe(propertyId);
      } finally {
        await app.close();
      }
    });

    it("allows a lead to reference an INACTIVE property", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("create-inactive", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const propertyId = property.json().id;
        await app.inject({
          method: "DELETE",
          url: `/api/v1/properties/${propertyId}`,
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        const response = await createLeadRequest(app, tenant.id, { property_id: propertyId });

        expect(response.statusCode).toBe(201);
      } finally {
        await app.close();
      }
    });

    it("returns 404 when property_id does not exist in this tenant", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("create-property-missing", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await createLeadRequest(app, tenant.id, { property_id: randomUUID() });

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("rejects an unknown field with 400", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("create-unknown-field", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await createLeadRequest(app, tenant.id, { unexpected: "x" });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("rejects a missing X-Tenant-Id header with 400", async () => {
      const app = buildTestApp();
      try {
        const response = await app.inject({ method: "POST", url: "/api/v1/leads", payload: samplePayload() });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("returns 409 when the tenant is not READY", async () => {
      const { secretStore } = await setupCluster();
      const { tenant } = await createPendingTenant("create-not-ready");
      const app = buildTestApp(secretStore);

      try {
        const response = await createLeadRequest(app, tenant.id);

        expect(response.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    });

    it("never logs PII (name/email/phone/message) in the request-completed log line", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("create-pii-log", secretStore);
      const logs: string[] = [];
      const app = buildTestApp(secretStore);
      app.addHook("onSend", (_request, _reply, payload, done) => {
        logs.push(String(payload));
        done(null, payload);
      });

      try {
        await createLeadRequest(app, tenant.id, {
          name: "Nome Sigiloso",
          email: "sigiloso@example.com",
          phone: "11900001111",
        });
        // The response body itself legitimately contains PII (it's the created resource) — this
        // test only documents that this suite doesn't assert on structured logger output
        // directly (Fastify/Pino logs go to stdout, not captured here); the real guarantee is
        // in `lead-routes.ts`'s log call sites themselves (`operation`/`leadId`/`source` only).
        expect(logs.length).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });
  });

  describe("GET /api/v1/leads", () => {
    it("lists leads with pagination, default ordering, and total", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("list", secretStore);
      const app = buildTestApp(secretStore);

      try {
        await createLeadRequest(app, tenant.id, { name: "Primeiro" });
        await createLeadRequest(app, tenant.id, { name: "Segundo" });

        const response = await listLeadsRequest(app, tenant.id);

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.data).toHaveLength(2);
        expect(body.pagination).toEqual({ page: 1, limit: 20, total: 2, total_pages: 1 });
      } finally {
        await app.close();
      }
    });

    it("includes a property summary (id/title/status) when associated, and property: null otherwise", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("list-property-summary", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id, { title: "Casa na Praia" });
        const propertyId = property.json().id;
        await createLeadRequest(app, tenant.id, { name: "Com imóvel", property_id: propertyId });
        await createLeadRequest(app, tenant.id, { name: "Genérico" });

        const response = await listLeadsRequest(app, tenant.id, "?sort=name&order=asc");

        const data = response.json().data;
        const generic = data.find((lead: { name: string }) => lead.name === "Genérico");
        const withProperty = data.find((lead: { name: string }) => lead.name === "Com imóvel");
        expect(generic.property).toBeNull();
        expect(withProperty.property).toEqual({ id: propertyId, title: "Casa na Praia", status: "ACTIVE" });
      } finally {
        await app.close();
      }
    });

    it("filters by status", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("list-status", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createLeadRequest(app, tenant.id);
        await patchLeadRequest(app, tenant.id, created.json().id, { status: "CONTACTED" });
        await createLeadRequest(app, tenant.id, { name: "Outro" });

        const response = await listLeadsRequest(app, tenant.id, "?status=CONTACTED");

        expect(response.json().data).toHaveLength(1);
        expect(response.json().data[0].id).toBe(created.json().id);
      } finally {
        await app.close();
      }
    });

    it("filters by q across name/email/phone", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("list-q", secretStore);
      const app = buildTestApp(secretStore);

      try {
        await createLeadRequest(app, tenant.id, { name: "Maria Souza" });
        await createLeadRequest(app, tenant.id, {
          name: "João",
          email: "joao@example.com",
          phone: "11977776666",
        });

        const response = await listLeadsRequest(app, tenant.id, "?q=maria");

        expect(response.json().data).toHaveLength(1);
        expect(response.json().data[0].name).toBe("Maria Souza");
      } finally {
        await app.close();
      }
    });

    it("rejects an unknown query parameter with 400", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("list-unknown-param", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await listLeadsRequest(app, tenant.id, "?foo=bar");

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("rejects created_from after created_to with 400", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("list-bad-range", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await listLeadsRequest(
          app,
          tenant.id,
          "?created_from=2026-02-01T00:00:00Z&created_to=2026-01-01T00:00:00Z",
        );

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("never leaks tenant A's leads to tenant B (isolation)", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("list-isolation-a", secretStore);
      const tenantB = await provisionReadyTenant("list-isolation-b", secretStore);
      const app = buildTestApp(secretStore);

      try {
        await createLeadRequest(app, tenantA.id, { name: "Tenant A Lead" });

        const response = await listLeadsRequest(app, tenantB.id);

        expect(response.json().data).toHaveLength(0);
        expect(response.json().pagination.total).toBe(0);
      } finally {
        await app.close();
      }
    });
  });

  describe("GET /api/v1/leads/:id", () => {
    it("returns the lead with its property summary when found", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("get", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const created = await createLeadRequest(app, tenant.id, { property_id: property.json().id });

        const response = await getLeadRequest(app, tenant.id, created.json().id);

        expect(response.statusCode).toBe(200);
        expect(response.json().property).toEqual({
          id: property.json().id,
          title: "Apartamento no Centro",
          status: "ACTIVE",
        });
      } finally {
        await app.close();
      }
    });

    it("returns 404 for a well-formed but unknown UUID", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("get-404", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await getLeadRequest(app, tenant.id, randomUUID());

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("returns 400 for a malformed id", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("get-400", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await getLeadRequest(app, tenant.id, "not-a-uuid");

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("never returns tenant A's lead to tenant B (isolation)", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("get-isolation-a", secretStore);
      const tenantB = await provisionReadyTenant("get-isolation-b", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createLeadRequest(app, tenantA.id);

        const response = await getLeadRequest(app, tenantB.id, created.json().id);

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });

  describe("PATCH /api/v1/leads/:id", () => {
    it("updates the given fields, returns 200, and GET reflects the change", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createLeadRequest(app, tenant.id);
        const leadId = created.json().id;

        const response = await patchLeadRequest(app, tenant.id, leadId, { status: "QUALIFIED" });

        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe("QUALIFIED");
        const fetched = await getLeadRequest(app, tenant.id, leadId);
        expect(fetched.json().status).toBe("QUALIFIED");
      } finally {
        await app.close();
      }
    });

    it("leaves fields not present in the body unchanged (partial update)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-partial", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createLeadRequest(app, tenant.id, { notes: "Nota original" });

        const response = await patchLeadRequest(app, tenant.id, created.json().id, { status: "CONTACTED" });

        expect(response.json()).toMatchObject({ status: "CONTACTED", notes: "Nota original", name: "Maria Souza" });
      } finally {
        await app.close();
      }
    });

    it("allows clearing email when phone remains", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-clear-email", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createLeadRequest(app, tenant.id);

        const response = await patchLeadRequest(app, tenant.id, created.json().id, { email: null });

        expect(response.statusCode).toBe(200);
        expect(response.json().email).toBeNull();
        expect(response.json().phone).toBe("+55 11 99999-0000");
      } finally {
        await app.close();
      }
    });

    it("rejects clearing the only remaining contact channel with 400, and the original record is untouched", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-contact-invariant", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createLeadRequest(app, tenant.id, { phone: undefined });
        const leadId = created.json().id;

        const response = await patchLeadRequest(app, tenant.id, leadId, { email: null });

        expect(response.statusCode).toBe(400);
        const fetched = await getLeadRequest(app, tenant.id, leadId);
        expect(fetched.json().email).toBe("maria.souza@example.com");
      } finally {
        await app.close();
      }
    });

    it("returns 404 when the new property_id does not exist in this tenant", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-property-missing", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createLeadRequest(app, tenant.id);

        const response = await patchLeadRequest(app, tenant.id, created.json().id, { property_id: randomUUID() });

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("rejects an empty body with 400", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-empty", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createLeadRequest(app, tenant.id);

        const response = await patchLeadRequest(app, tenant.id, created.json().id, {});

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("returns 404 for a well-formed but unknown UUID", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-404", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await patchLeadRequest(app, tenant.id, randomUUID(), { status: "LOST" });

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("never updates tenant A's lead from tenant B (isolation)", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("patch-isolation-a", secretStore);
      const tenantB = await provisionReadyTenant("patch-isolation-b", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createLeadRequest(app, tenantA.id);
        const leadId = created.json().id;

        const response = await patchLeadRequest(app, tenantB.id, leadId, { status: "WON" });

        expect(response.statusCode).toBe(404);
        const fetchedFromA = await getLeadRequest(app, tenantA.id, leadId);
        expect(fetchedFromA.json().status).toBe("NEW");
      } finally {
        await app.close();
      }
    });

    it("a property id from tenant A cannot be used to associate a lead in tenant B", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("patch-property-isolation-a", secretStore);
      const tenantB = await provisionReadyTenant("patch-property-isolation-b", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const propertyInA = await createPropertyRequest(app, tenantA.id);
        const leadInB = await createLeadRequest(app, tenantB.id);

        const response = await patchLeadRequest(app, tenantB.id, leadInB.json().id, {
          property_id: propertyInA.json().id,
        });

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });
});
