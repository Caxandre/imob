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
 * `lead-routes.test.ts`. Each `it()` calls `buildTestApp()` fresh, which gives every test its
 * own Fastify instance and therefore its own in-memory rate-limit counter (Prompt 045, section
 * 55) — no cross-test contamination.
 */
const CLUSTER_NAME = "e2e-public-lead-capture-cluster";
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
    name: `Public Lead Capture E2E ${slugPrefix}`,
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

function sampleCapturePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Maria Souza",
    email: "maria.souza@example.com",
    phone: "+55 11 99999-0000",
    message: "Tenho interesse neste apartamento.",
    ...overrides,
  };
}

async function createPropertyRequest(app: FastifyInstance, tenantId: string, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/properties",
    headers: { [TENANT_ID_HEADER]: tenantId },
    payload: samplePropertyPayload(overrides),
  });
}

async function captureLeadRequest(
  app: FastifyInstance,
  tenantId: string,
  propertyId: string,
  overrides: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/public/properties/${propertyId}/leads`,
    headers: { [TENANT_ID_HEADER]: tenantId },
    payload: sampleCapturePayload(overrides),
  });
}

async function listLeadsRequest(app: FastifyInstance, tenantId: string) {
  return app.inject({ method: "GET", url: "/api/v1/leads", headers: { [TENANT_ID_HEADER]: tenantId } });
}

describe("Public property lead capture", () => {
  describe("POST /api/v1/public/properties/:propertyId/leads", () => {
    it("captures a lead for an ACTIVE property and returns 201 with only { id }", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("active", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const propertyId = property.json().id;

        const response = await captureLeadRequest(app, tenant.id, propertyId);

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(Object.keys(body)).toEqual(["id"]);
        expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        await app.close();
      }
    });

    it("persists the lead as NEW/WEBSITE, bound to the URL property, with notes null", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("persisted", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const propertyId = property.json().id;

        const captured = await captureLeadRequest(app, tenant.id, propertyId, { message: "Quero visitar." });

        const list = await listLeadsRequest(app, tenant.id);
        const persisted = list.json().data.find((lead: { id: string }) => lead.id === captured.json().id);

        expect(persisted).toMatchObject({
          status: "NEW",
          source: "WEBSITE",
          property_id: propertyId,
          name: "Maria Souza",
          email: "maria.souza@example.com",
          phone: "+55 11 99999-0000",
          message: "Quero visitar.",
          notes: null,
        });
      } finally {
        await app.close();
      }
    });

    it("accepts a lead with only email (no phone)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("email-only", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const response = await captureLeadRequest(app, tenant.id, property.json().id, { phone: undefined });

        expect(response.statusCode).toBe(201);
      } finally {
        await app.close();
      }
    });

    it("accepts a lead with only phone (no email)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("phone-only", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const response = await captureLeadRequest(app, tenant.id, property.json().id, { email: undefined });

        expect(response.statusCode).toBe(201);
      } finally {
        await app.close();
      }
    });

    it("accepts a lead with a null/absent message", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("no-message", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const response = await captureLeadRequest(app, tenant.id, property.json().id, { message: undefined });

        expect(response.statusCode).toBe(201);
      } finally {
        await app.close();
      }
    });

    it("rejects a submission with neither email nor phone (400)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("no-contact", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const response = await captureLeadRequest(app, tenant.id, property.json().id, {
          email: undefined,
          phone: undefined,
        });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it.each(["status", "source", "notes", "property_id"])(
      "rejects an unknown administrative field (%s) with 400",
      async (field) => {
        const { secretStore } = await setupCluster();
        const tenant = await provisionReadyTenant(`admin-field-${field}`, secretStore);
        const app = buildTestApp(secretStore);

        try {
          const property = await createPropertyRequest(app, tenant.id);
          const response = await captureLeadRequest(app, tenant.id, property.json().id, {
            [field]: field === "property_id" ? randomUUID() : "WON",
          });

          expect(response.statusCode).toBe(400);
        } finally {
          await app.close();
        }
      },
    );

    it("rejects an unknown id/created_at/updated_at field with 400", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("admin-field-id", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const response = await captureLeadRequest(app, tenant.id, property.json().id, {
          id: randomUUID(),
          created_at: new Date().toISOString(),
        });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("a property_id sent in the URL is used even if the body tries to override it (body property_id is rejected, not merged)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("url-vs-body", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const propertyA = await createPropertyRequest(app, tenant.id, { title: "Imóvel A" });
        const propertyB = await createPropertyRequest(app, tenant.id, { title: "Imóvel B" });

        const response = await captureLeadRequest(app, tenant.id, propertyA.json().id, {
          property_id: propertyB.json().id,
        });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("returns 404 for a DRAFT property, and never creates a lead", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("draft", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id, { status: "DRAFT" });

        const response = await captureLeadRequest(app, tenant.id, property.json().id);

        expect(response.statusCode).toBe(404);
        const list = await listLeadsRequest(app, tenant.id);
        expect(list.json().data).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it("returns 404 for an INACTIVE property, and never creates a lead", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("inactive", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        await app.inject({
          method: "DELETE",
          url: `/api/v1/properties/${property.json().id}`,
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        const response = await captureLeadRequest(app, tenant.id, property.json().id);

        expect(response.statusCode).toBe(404);
        const list = await listLeadsRequest(app, tenant.id);
        expect(list.json().data).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it("returns 404 for a well-formed but unknown property id, and never creates a lead", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("missing-property", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await captureLeadRequest(app, tenant.id, randomUUID());

        expect(response.statusCode).toBe(404);
        const list = await listLeadsRequest(app, tenant.id);
        expect(list.json().data).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it("DRAFT and missing-property responses are identical (never reveal a property exists but is unavailable)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("uniform-404", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const draftProperty = await createPropertyRequest(app, tenant.id, { status: "DRAFT" });

        const draftResponse = await captureLeadRequest(app, tenant.id, draftProperty.json().id);
        const missingResponse = await captureLeadRequest(app, tenant.id, randomUUID());

        // Same status and the same message *shape* — each only echoes back the id the caller
        // already sent in the URL, never a hint distinguishing "exists but DRAFT" from "does
        // not exist at all".
        expect(draftResponse.statusCode).toBe(404);
        expect(missingResponse.statusCode).toBe(404);
        expect(draftResponse.json().message).toBe(`Property "${draftProperty.json().id}" was not found`);
        expect(missingResponse.json().error).toBe(draftResponse.json().error);
      } finally {
        await app.close();
      }
    });

    it("returns 400 for a malformed property id in the URL", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("malformed-id", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/public/properties/not-a-uuid/leads",
          headers: { [TENANT_ID_HEADER]: tenant.id },
          payload: sampleCapturePayload(),
        });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("rejects a missing X-Tenant-Id header with 400", async () => {
      const app = buildTestApp();
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/public/properties/${randomUUID()}/leads`,
          payload: sampleCapturePayload(),
        });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("returns 409 when the tenant is not READY", async () => {
      const { secretStore } = await setupCluster();
      const { tenant } = await createPendingTenant("not-ready");
      const app = buildTestApp(secretStore);

      try {
        const response = await captureLeadRequest(app, tenant.id, randomUUID());

        expect(response.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    });

    it("never leaks tenant A's property to a capture attempt from tenant B (404, no lead in B)", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("isolation-a", secretStore);
      const tenantB = await provisionReadyTenant("isolation-b", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const propertyInA = await createPropertyRequest(app, tenantA.id);

        const response = await captureLeadRequest(app, tenantB.id, propertyInA.json().id);

        expect(response.statusCode).toBe(404);
        const listB = await listLeadsRequest(app, tenantB.id);
        expect(listB.json().data).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it("response body never contains PII or internal lead fields beyond the minimal { id } contract", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("response-shape", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);

        const response = await captureLeadRequest(app, tenant.id, property.json().id, {
          name: "Nome Sigiloso",
          email: "sigiloso@example.com",
          phone: "11900001111",
          message: "Mensagem sigilosa",
        });

        const rawBody = response.body;
        expect(rawBody).not.toContain("Nome Sigiloso");
        expect(rawBody).not.toContain("sigiloso@example.com");
        expect(rawBody).not.toContain("11900001111");
        expect(rawBody).not.toContain("Mensagem sigilosa");
        expect(rawBody).not.toContain("status");
        expect(rawBody).not.toContain("source");
        expect(rawBody).not.toContain("property");
      } finally {
        await app.close();
      }
    });

    it("enforces the per-route rate limit: allows 5 requests per minute, rejects the 6th with 429", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("rate-limited", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);
        const propertyId = property.json().id;

        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const response = await captureLeadRequest(app, tenant.id, propertyId);
          expect(response.statusCode).toBe(201);
        }

        const sixth = await captureLeadRequest(app, tenant.id, propertyId);
        expect(sixth.statusCode).toBe(429);
      } finally {
        await app.close();
      }
    });

    it("a fresh app instance starts with its own rate-limit counter (no cross-test contamination)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("rate-limit-isolation", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const property = await createPropertyRequest(app, tenant.id);

        const response = await captureLeadRequest(app, tenant.id, property.json().id);

        expect(response.statusCode).toBe(201);
      } finally {
        await app.close();
      }
    });
  });
});
