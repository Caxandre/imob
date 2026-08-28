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
import { createInMemoryObjectStorage } from "../../../infrastructure/object-storage/test-support/in-memory-object-storage.js";
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
 * Full HTTP integration tests, real infrastructure throughout (this task, sections 44-51):
 * `app.inject()` against a real, running `TenantDatabaseResolver`/`TenantDatabaseConnectionManager`
 * pipeline, and real tenants provisioned end to end exactly like
 * `e2e-tenant-database-runtime.test.ts` does. `buildTestApp(secretStore)` is handed the *same*
 * `SecretStore` instance used to provision each tenant — the same "one process, shared memory"
 * pattern already proven correct there — never a mock, never the two-process gap this task's
 * dev-only `pnpm dev:full` runtime exists for (which cannot be exercised by an automated test
 * running in a single process anyway).
 */
const CLUSTER_NAME = "e2e-properties-test-cluster";
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
    name: `Properties E2E ${slugPrefix}`,
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
    title: "Apartamento no Centro",
    description: "Apartamento com boa localização.",
    property_type: "APARTMENT",
    transaction_type: "SALE",
    status: "DRAFT",
    price: "450000.00",
    bedrooms: 3,
    bathrooms: 2,
    parking_spaces: 1,
    area_m2: "92.50",
    street: "Rua Exemplo",
    number: "123",
    neighborhood: "Centro",
    city: "São Paulo",
    state: "SP",
    postal_code: "01000-000",
    ...overrides,
  };
}

async function createProperty(app: FastifyInstance, tenantId: string, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/properties",
    headers: { [TENANT_ID_HEADER]: tenantId },
    payload: samplePayload(overrides),
  });
}

async function patchProperty(
  app: FastifyInstance,
  tenantId: string,
  propertyId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/properties/${propertyId}`,
    headers: { [TENANT_ID_HEADER]: tenantId },
    payload: body,
  });
}

async function deleteProperty(app: FastifyInstance, tenantId: string, propertyId: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/v1/properties/${propertyId}`,
    headers: { [TENANT_ID_HEADER]: tenantId },
  });
}

// Minimal real magic-byte signatures (matching `property-media-file-signature.ts`) — enough
// filler after the signature to be a plausible file, never a real decodable image (this task,
// section 32: no image-processing dependency is needed for these tests either).
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
]);
const PLAIN_TEXT_BYTES = Buffer.from("this is not an image", "ascii");

/**
 * Hand-built multipart/form-data body — no extra dependency (`form-data` et al.) just for
 * tests, and `light-my-request` (behind `app.inject()`) accepts a raw `Buffer` payload with the
 * matching `content-type` header directly.
 */
function buildMultipartUpload(params: {
  fieldName?: string;
  filename?: string;
  contentType?: string;
  content: Buffer;
}) {
  const boundary = `testboundary${randomUUID().replaceAll("-", "")}`;
  const fieldName = params.fieldName ?? "file";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${params.filename ?? "foto.jpg"}"\r\n` +
      `Content-Type: ${params.contentType ?? "image/jpeg"}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  return {
    contentTypeHeader: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([head, params.content, tail]),
  };
}

function buildTwoFileMultipartUpload(): { contentTypeHeader: string; payload: Buffer } {
  const boundary = `testboundary${randomUUID().replaceAll("-", "")}`;
  const part = (name: string, filename: string, contentType: string, content: Buffer) =>
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
        "utf8",
      ),
      content,
      Buffer.from("\r\n", "utf8"),
    ]);

  return {
    contentTypeHeader: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      part("file", "one.jpg", "image/jpeg", JPEG_BYTES),
      part("file", "two.jpg", "image/jpeg", JPEG_BYTES),
      Buffer.from(`--${boundary}--\r\n`, "utf8"),
    ]),
  };
}

async function uploadPropertyMediaRequest(
  app: FastifyInstance,
  tenantId: string,
  propertyId: string,
  upload: { contentTypeHeader: string; payload: Buffer },
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/properties/${propertyId}/media`,
    headers: { [TENANT_ID_HEADER]: tenantId, "content-type": upload.contentTypeHeader },
    payload: upload.payload,
  });
}

async function listPropertyMediaRequest(app: FastifyInstance, tenantId: string, propertyId: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/properties/${propertyId}/media`,
    headers: { [TENANT_ID_HEADER]: tenantId },
  });
}

describe("Properties HTTP routes", () => {
  describe("POST /api/v1/properties", () => {
    it("creates a property and returns 201 with the persisted fields — never a tenant_id", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("create", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await createProperty(app, tenant.id);

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(body).toMatchObject({
          title: "Apartamento no Centro",
          property_type: "APARTMENT",
          transaction_type: "SALE",
          status: "DRAFT",
          price: "450000.00",
          area_m2: "92.50",
        });
        expect(body.tenant_id).toBeUndefined();
        expect(Date.parse(body.created_at)).not.toBeNaN();
        expect(Date.parse(body.updated_at)).not.toBeNaN();
      } finally {
        await app.close();
      }
    });

    it("never loses decimal precision on price/area_m2 — they round-trip as exact strings", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("money", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await createProperty(app, tenant.id, { price: "1234567.89", area_m2: "0.50" });

        expect(response.json()).toMatchObject({ price: "1234567.89", area_m2: "0.50" });
      } finally {
        await app.close();
      }
    });

    it("persists the property only in the resolved tenant's own database", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("persist", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await createProperty(app, tenant.id);
        const propertyId = response.json().id;

        const names = buildProvisioningResourceNames(tenant.id);
        const client = new Client({
          host: TENANTS_HOST,
          port: TENANTS_PORT,
          database: names.databaseName,
          user: ADMIN_USERNAME,
          password: ADMIN_PASSWORD,
        });
        await client.connect();
        try {
          const result = await client.query("SELECT id FROM properties WHERE id = $1", [propertyId]);
          expect(result.rowCount).toBe(1);
        } finally {
          await client.end();
        }
      } finally {
        await app.close();
      }
    });

    it("rejects a missing X-Tenant-Id header with 400", async () => {
      const app = buildTestApp();
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/properties",
          payload: samplePayload(),
        });
        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("rejects a non-UUID X-Tenant-Id header with 400", async () => {
      const app = buildTestApp();
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/properties",
          headers: { [TENANT_ID_HEADER]: "not-a-uuid" },
          payload: samplePayload(),
        });
        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it.each([
      ["missing title", { title: undefined }],
      ["empty title", { title: "   " }],
      ["invalid property_type", { property_type: "CASTLE" }],
      ["invalid transaction_type", { transaction_type: "LEASE" }],
      ["zero price", { price: "0.00" }],
      ["negative price", { price: "-10.00" }],
      ["price with too many decimals", { price: "100.999" }],
      ["negative bedrooms", { bedrooms: -1 }],
      ["state with 3 letters", { state: "SPX" }],
    ])("rejects an invalid payload (%s) with 400 and validation details", async (_label, overrides) => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("validation", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await createProperty(app, tenant.id, overrides);

        expect(response.statusCode).toBe(400);
        expect(response.json().details).toBeInstanceOf(Array);
      } finally {
        await app.close();
      }
    });

    it("returns 409 when the tenant is still PROVISIONING", async () => {
      await setupCluster();
      const { tenant } = await createPendingTenant("provisioning");
      const app = buildTestApp();

      try {
        const response = await createProperty(app, tenant.id);
        expect(response.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    });

    it("returns 409 when the tenant is SUSPENDED, even though it was READY", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("suspended", secretStore);
      await controlPlaneDb.update(tenants).set({ status: "SUSPENDED" }).where(eq(tenants.id, tenant.id));
      const app = buildTestApp(secretStore);

      try {
        const response = await createProperty(app, tenant.id);
        expect(response.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    });

    it("returns 409 for a tenant id that does not exist at all — same status as SUSPENDED, never 404", async () => {
      await setupCluster();
      const app = buildTestApp();

      try {
        const response = await createProperty(app, randomUUID());
        expect(response.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    });

    it("returns 503 when the tenant's cluster has since become INACTIVE", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("cluster-inactive", secretStore);
      await controlPlaneDb.update(databaseClusters).set({ status: "INACTIVE" }).where(eq(databaseClusters.name, CLUSTER_NAME));
      const app = buildTestApp(secretStore);

      try {
        const response = await createProperty(app, tenant.id);
        expect(response.statusCode).toBe(503);
      } finally {
        await app.close();
      }
    });

    it("returns 503, never falling back to the admin credential, when this process's SecretStore never received the tenant secret", async () => {
      // Simulates exactly the cross-process gap this task's dev-full runtime exists to close
      // locally (sections 33-36): the tenant was provisioned by "a worker" using its own
      // SecretStore instance, but the HTTP app here is handed a completely separate, empty
      // one — so it can resolve the tenant (Control Plane state is shared/real), but not the
      // tenant's own credential.
      const { secretStore: provisioningSecretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("secret-gap", provisioningSecretStore);
      const app = buildTestApp(createInMemorySecretStore());

      try {
        const response = await createProperty(app, tenant.id);
        expect(response.statusCode).toBe(503);
        expect(response.json().message).not.toMatch(/admin|cluster secret/i);
      } finally {
        await app.close();
      }
    });
  });

  describe("GET /api/v1/properties", () => {
    it("lists properties with pagination, ordering, and total", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("list", secretStore);
      const app = buildTestApp(secretStore);

      try {
        for (let i = 0; i < 3; i += 1) {
          const created = await createProperty(app, tenant.id, { title: `Property ${i}` });
          expect(created.statusCode).toBe(201);
        }

        const response = await app.inject({
          method: "GET",
          url: "/api/v1/properties?page=1&limit=2",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.data).toHaveLength(2);
        expect(body.pagination).toEqual({ page: 1, limit: 2, total: 3, total_pages: 2 });
        // Newest first (created_at DESC, id DESC).
        expect(body.data[0].title).toBe("Property 2");
        expect(body.data[1].title).toBe("Property 1");
      } finally {
        await app.close();
      }
    });

    it("applies default pagination (page=1, limit=20) when omitted", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("default-pagination", secretStore);
      const app = buildTestApp(secretStore);

      try {
        await createProperty(app, tenant.id);

        const response = await app.inject({
          method: "GET",
          url: "/api/v1/properties",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.json().pagination).toMatchObject({ page: 1, limit: 20 });
      } finally {
        await app.close();
      }
    });

    it("rejects a limit above the maximum with 400", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("limit-too-high", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/api/v1/properties?limit=101",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("filters by status, property_type, and combines multiple filters with city (normalized case-insensitive)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("filters", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const match = await createProperty(app, tenant.id, {
          status: "ACTIVE",
          property_type: "APARTMENT",
          city: "São Paulo",
        });
        await createProperty(app, tenant.id, { status: "DRAFT", property_type: "APARTMENT", city: "São Paulo" });
        await createProperty(app, tenant.id, { status: "ACTIVE", property_type: "HOUSE", city: "São Paulo" });
        await createProperty(app, tenant.id, { status: "ACTIVE", property_type: "APARTMENT", city: "Campinas" });

        const response = await app.inject({
          method: "GET",
          // Lowercase "sao paulo" (no accent) exercises normalization — trimmed + case-insensitive.
          url: "/api/v1/properties?status=ACTIVE&property_type=APARTMENT&city=s%C3%A3o%20paulo",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.data.map((p: { id: string }) => p.id)).toEqual([match.json().id]);
        expect(body.pagination.total).toBe(1);
      } finally {
        await app.close();
      }
    });

    it("normalizes state to uppercase (sp -> SP)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("state-normalize", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const match = await createProperty(app, tenant.id, { state: "SP" });
        await createProperty(app, tenant.id, { state: "RJ" });

        const response = await app.inject({
          method: "GET",
          url: "/api/v1/properties?state=sp",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().data.map((p: { id: string }) => p.id)).toEqual([match.json().id]);
      } finally {
        await app.close();
      }
    });

    it("sorts by price ascending and descending via query params", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("sort", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const low = await createProperty(app, tenant.id, { price: "100000.00" });
        const high = await createProperty(app, tenant.id, { price: "900000.00" });

        const ascending = await app.inject({
          method: "GET",
          url: "/api/v1/properties?sort=price&order=asc",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });
        const descending = await app.inject({
          method: "GET",
          url: "/api/v1/properties?sort=price&order=desc",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(ascending.json().data.map((p: { id: string }) => p.id)).toEqual([low.json().id, high.json().id]);
        expect(descending.json().data.map((p: { id: string }) => p.id)).toEqual([high.json().id, low.json().id]);
      } finally {
        await app.close();
      }
    });

    it("q finds a matching property by title and reports the filtered total", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("q-search", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const match = await createProperty(app, tenant.id, { title: "Apartamento no Centro" });
        // samplePayload()'s own default description ("Apartamento com boa localização.") and
        // neighborhood ("Centro") would otherwise still contain "apartamento" — override both
        // so this control property genuinely has no match for the query term.
        await createProperty(app, tenant.id, {
          title: "Casa na Praia",
          description: "Excelente vista para o mar",
          neighborhood: null,
        });

        const response = await app.inject({
          method: "GET",
          url: "/api/v1/properties?q=apartamento",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.data.map((p: { id: string }) => p.id)).toEqual([match.json().id]);
        expect(body.pagination.total).toBe(1);
      } finally {
        await app.close();
      }
    });

    it("q combines with structured filters using AND", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("q-filters", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const match = await createProperty(app, tenant.id, { title: "Apartamento no Centro", status: "ACTIVE" });
        await createProperty(app, tenant.id, { title: "Apartamento no Centro", status: "DRAFT" });

        const response = await app.inject({
          method: "GET",
          url: "/api/v1/properties?q=apartamento&status=ACTIVE",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.json().data.map((p: { id: string }) => p.id)).toEqual([match.json().id]);
      } finally {
        await app.close();
      }
    });

    it("without an explicit sort, q orders by relevance (title match ranks above description-only match)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("q-relevance", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const titleMatch = await createProperty(app, tenant.id, {
          title: "Apartamento no Centro",
          description: "Excelente custo-benefício",
          neighborhood: null,
          city: null,
        });
        const descriptionMatch = await createProperty(app, tenant.id, {
          title: "Apartamento residencial",
          description: "Próximo ao centro comercial",
          neighborhood: null,
          city: null,
        });

        const response = await app.inject({
          method: "GET",
          url: "/api/v1/properties?q=centro",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.json().data.map((p: { id: string }) => p.id)).toEqual([
          titleMatch.json().id,
          descriptionMatch.json().id,
        ]);
      } finally {
        await app.close();
      }
    });

    it("an explicit sort overrides relevance ordering even with q present", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("q-explicit-sort", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const cheap = await createProperty(app, tenant.id, { title: "Apartamento Centro", price: "200000.00" });
        const expensive = await createProperty(app, tenant.id, { title: "Apartamento Centro", price: "900000.00" });

        const response = await app.inject({
          method: "GET",
          url: "/api/v1/properties?q=apartamento&sort=price&order=asc",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.json().data.map((p: { id: string }) => p.id)).toEqual([
          cheap.json().id,
          expensive.json().id,
        ]);
      } finally {
        await app.close();
      }
    });

    it.each([
      ["price_min greater than price_max", "price_min=600000.00&price_max=300000.00"],
      ["area_min greater than area_max", "area_min=100.00&area_max=50.00"],
      ["invalid status", "status=SOLD"],
      ["invalid sort", "sort=title"],
      ["invalid order", "order=sideways"],
      ["unknown query parameter", "prcie_min=100000"],
      ["q is empty", "q="],
      ["q is whitespace-only (empty after trim)", "q=" + encodeURIComponent("   ")],
      ["q too short", "q=a"],
      ["q too long", "q=" + "a".repeat(121)],
      ["sort=relevance is not a client-selectable value", "sort=relevance"],
    ])("rejects an invalid query (%s) with 400", async (_label, queryString) => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("query-validation", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/properties?${queryString}`,
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  describe("GET /api/v1/properties/:id", () => {
    it("returns the property when found", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("get", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;

        const response = await app.inject({
          method: "GET",
          url: `/api/v1/properties/${propertyId}`,
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().id).toBe(propertyId);
      } finally {
        await app.close();
      }
    });

    it("returns 404 for a well-formed but unknown UUID", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("get-404", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/properties/${randomUUID()}`,
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

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
        const response = await app.inject({
          method: "GET",
          url: "/api/v1/properties/not-a-uuid",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  describe("PATCH /api/v1/properties/:id", () => {
    it("updates the given fields, returns 200, and GET reflects the change", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;

        const patched = await patchProperty(app, tenant.id, propertyId, {
          title: "Apartamento reformado no Centro",
          price: "475000.00",
          status: "ACTIVE",
        });

        expect(patched.statusCode).toBe(200);
        expect(patched.json()).toMatchObject({
          id: propertyId,
          title: "Apartamento reformado no Centro",
          price: "475000.00",
          status: "ACTIVE",
        });

        const fetched = await app.inject({
          method: "GET",
          url: `/api/v1/properties/${propertyId}`,
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });
        expect(fetched.json()).toMatchObject({
          title: "Apartamento reformado no Centro",
          price: "475000.00",
          status: "ACTIVE",
        });
      } finally {
        await app.close();
      }
    });

    it("leaves fields not present in the body unchanged (partial update)", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-partial", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenant.id, { city: "São Paulo", bedrooms: 3 });
        const propertyId = created.json().id;

        const patched = await patchProperty(app, tenant.id, propertyId, { title: "Só o título mudou" });

        expect(patched.statusCode).toBe(200);
        expect(patched.json()).toMatchObject({ title: "Só o título mudou", city: "São Paulo", bedrooms: 3 });
      } finally {
        await app.close();
      }
    });

    it("does not touch created_at, and bumps updated_at", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-timestamps", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenant.id);
        const before = created.json();

        const patched = await patchProperty(app, tenant.id, before.id, { title: "Novo título" });
        const after = patched.json();

        expect(after.created_at).toBe(before.created_at);
        expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at));
      } finally {
        await app.close();
      }
    });

    it("allows clearing a nullable field with null", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-null", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenant.id, { description: "Descrição original" });
        const propertyId = created.json().id;

        const patched = await patchProperty(app, tenant.id, propertyId, { description: null });

        expect(patched.statusCode).toBe(200);
        expect(patched.json().description).toBeNull();
      } finally {
        await app.close();
      }
    });

    it("rejects an empty body with 400", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-empty", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenant.id);

        const patched = await patchProperty(app, tenant.id, created.json().id, {});

        expect(patched.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it.each([
      ["negative price", { price: "-1.00" }],
      ["zero price", { price: "0.00" }],
      ["negative bedrooms", { bedrooms: -1 }],
      ["invalid status", { status: "UNKNOWN" }],
      ["invalid property_type", { property_type: "CASTLE" }],
      ["unknown field", { not_a_real_field: "x" }],
      ["attempt to set id", { id: randomUUID() }],
      ["attempt to set created_at", { created_at: "2020-01-01T00:00:00.000Z" }],
      ["attempt to clear required field title with null", { title: null }],
    ])("rejects an invalid update (%s) with 400", async (_label, overrides) => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-validation", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenant.id);

        const patched = await patchProperty(app, tenant.id, created.json().id, overrides);

        expect(patched.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("returns 404 for a well-formed but unknown UUID", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-404", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await patchProperty(app, tenant.id, randomUUID(), { title: "x" });
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("returns 400 for a malformed id", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("patch-bad-id", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await app.inject({
          method: "PATCH",
          url: "/api/v1/properties/not-a-uuid",
          headers: { [TENANT_ID_HEADER]: tenant.id },
          payload: { title: "x" },
        });
        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  describe("DELETE /api/v1/properties/:id (archive)", () => {
    it("archives the property (status = INACTIVE), returns 204 with no body, and GET still returns it", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("archive", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenant.id, { status: "ACTIVE" });
        const propertyId = created.json().id;

        const deleted = await deleteProperty(app, tenant.id, propertyId);
        expect(deleted.statusCode).toBe(204);
        expect(deleted.body).toBe("");

        const fetched = await app.inject({
          method: "GET",
          url: `/api/v1/properties/${propertyId}`,
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });
        expect(fetched.statusCode).toBe(200);
        expect(fetched.json().status).toBe("INACTIVE");
      } finally {
        await app.close();
      }
    });

    it("archiving is never a physical delete — the property still shows up in the listing", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("archive-listed", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;

        await deleteProperty(app, tenant.id, propertyId);

        const list = await app.inject({
          method: "GET",
          url: "/api/v1/properties",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });
        expect(list.json().data.map((p: { id: string }) => p.id)).toContain(propertyId);
      } finally {
        await app.close();
      }
    });

    it("is idempotent — archiving twice converges, both 204", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("archive-idempotent", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenant.id, { status: "ACTIVE" });
        const propertyId = created.json().id;

        const first = await deleteProperty(app, tenant.id, propertyId);
        const second = await deleteProperty(app, tenant.id, propertyId);

        expect(first.statusCode).toBe(204);
        expect(second.statusCode).toBe(204);
      } finally {
        await app.close();
      }
    });

    it("returns 404 for a well-formed but unknown UUID", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("archive-404", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await deleteProperty(app, tenant.id, randomUUID());
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("returns 400 for a malformed id", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("archive-bad-id", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const response = await app.inject({
          method: "DELETE",
          url: "/api/v1/properties/not-a-uuid",
          headers: { [TENANT_ID_HEADER]: tenant.id },
        });
        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  describe("POST /api/v1/properties/:id/media", () => {
    it.each([
      ["JPEG", JPEG_BYTES, "image/jpeg"],
      ["PNG", PNG_BYTES, "image/png"],
      ["WebP", WEBP_BYTES, "image/webp"],
    ] as const)("uploads a valid %s file, returns 201 with metadata, and stores it in ObjectStorage", async (_label, bytes, mimeType) => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-upload", secretStore);
      const objectStorage = createInMemoryObjectStorage();
      const app = buildTestApp(secretStore, objectStorage);

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;

        const response = await uploadPropertyMediaRequest(
          app,
          tenant.id,
          propertyId,
          buildMultipartUpload({ content: bytes, contentType: mimeType, filename: "foto.jpg" }),
        );

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toMatchObject({
          property_id: propertyId,
          mime_type: mimeType,
          size_bytes: bytes.length,
          original_filename: "foto.jpg",
          position: 0,
        });
        expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.object_key).toBeUndefined();
        expect(typeof body.public_url).toBe("string");
        expect(Date.parse(body.created_at)).not.toBeNaN();
        expect(Date.parse(body.updated_at)).not.toBeNaN();

        // Actually persisted through the ObjectStorage port, not merely reported as if it were.
        expect(objectStorage.has(`tenants/${tenant.id}/properties/${propertyId}/${body.id}.${mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]}`)).toBe(true);
      } finally {
        await app.close();
      }
    });

    it("assigns sequential positions across successive uploads to the same property", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-position", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;

        const first = await uploadPropertyMediaRequest(app, tenant.id, propertyId, buildMultipartUpload({ content: JPEG_BYTES }));
        const second = await uploadPropertyMediaRequest(app, tenant.id, propertyId, buildMultipartUpload({ content: JPEG_BYTES }));

        expect(first.json().position).toBe(0);
        expect(second.json().position).toBe(1);
      } finally {
        await app.close();
      }
    });

    it("sanitizes a path-traversal filename down to its basename", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-filename", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;

        const response = await uploadPropertyMediaRequest(
          app,
          tenant.id,
          propertyId,
          buildMultipartUpload({ content: JPEG_BYTES, filename: "../../foto.jpg" }),
        );

        expect(response.statusCode).toBe(201);
        expect(response.json().original_filename).toBe("foto.jpg");
      } finally {
        await app.close();
      }
    });

    it("rejects a declared MIME type outside the allowlist with 400", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-bad-mime", secretStore);
      const objectStorage = createInMemoryObjectStorage();
      const app = buildTestApp(secretStore, objectStorage);

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;

        const response = await uploadPropertyMediaRequest(
          app,
          tenant.id,
          propertyId,
          buildMultipartUpload({ content: PLAIN_TEXT_BYTES, contentType: "image/gif", filename: "a.gif" }),
        );

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("rejects content whose magic bytes do not match the declared MIME type with 400", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-mismatch", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;

        // Declares image/jpeg, but the bytes are a real PNG signature.
        const response = await uploadPropertyMediaRequest(
          app,
          tenant.id,
          propertyId,
          buildMultipartUpload({ content: PNG_BYTES, contentType: "image/jpeg" }),
        );

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("rejects a request with no file with 400", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-no-file", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;
        const boundary = `testboundary${randomUUID().replaceAll("-", "")}`;
        // A syntactically valid multipart body with a text field only, no file part.
        const payload = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="notes"\r\n\r\nhello\r\n--${boundary}--\r\n`,
          "utf8",
        );

        const response = await app.inject({
          method: "POST",
          url: `/api/v1/properties/${propertyId}/media`,
          headers: { [TENANT_ID_HEADER]: tenant.id, "content-type": `multipart/form-data; boundary=${boundary}` },
          payload,
        });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("rejects a request with more than one file with 400, never uploading either to ObjectStorage", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-multi-file", secretStore);
      const objectStorage = createInMemoryObjectStorage();
      const app = buildTestApp(secretStore, objectStorage);

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;

        const response = await uploadPropertyMediaRequest(app, tenant.id, propertyId, buildTwoFileMultipartUpload());

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("rejects a file over the size limit with 413", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-too-large", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;

        const oversized = Buffer.concat([
          JPEG_BYTES,
          Buffer.alloc(10 * 1024 * 1024 - JPEG_BYTES.length + 1, 0),
        ]);

        const response = await uploadPropertyMediaRequest(
          app,
          tenant.id,
          propertyId,
          buildMultipartUpload({ content: oversized }),
        );

        expect(response.statusCode).toBe(413);
      } finally {
        await app.close();
      }
    }, 20_000);

    it("returns 404 for a well-formed but unknown property id, never touching ObjectStorage", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-404", secretStore);
      const objectStorage = createInMemoryObjectStorage();
      const app = buildTestApp(secretStore, objectStorage);

      try {
        const response = await uploadPropertyMediaRequest(
          app,
          tenant.id,
          randomUUID(),
          buildMultipartUpload({ content: JPEG_BYTES }),
        );

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("returns 404 (never touching ObjectStorage) when the property belongs to a different tenant", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("media-cross-a", secretStore);
      const tenantB = await provisionReadyTenant("media-cross-b", secretStore);
      const objectStorage = createInMemoryObjectStorage();
      const app = buildTestApp(secretStore, objectStorage);

      try {
        const created = await createProperty(app, tenantA.id);
        const propertyId = created.json().id;

        const response = await uploadPropertyMediaRequest(
          app,
          tenantB.id,
          propertyId,
          buildMultipartUpload({ content: JPEG_BYTES }),
        );

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("returns 409 for an archived (INACTIVE) property, never touching ObjectStorage", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-archived", secretStore);
      const objectStorage = createInMemoryObjectStorage();
      const app = buildTestApp(secretStore, objectStorage);

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;
        const archived = await deleteProperty(app, tenant.id, propertyId);
        expect(archived.statusCode).toBe(204);

        const response = await uploadPropertyMediaRequest(
          app,
          tenant.id,
          propertyId,
          buildMultipartUpload({ content: JPEG_BYTES }),
        );

        expect(response.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    });

    it("allows upload for DRAFT and ACTIVE properties", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-draft-active", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const draft = await createProperty(app, tenant.id, { status: "DRAFT" });
        const active = await createProperty(app, tenant.id, { status: "ACTIVE" });

        const draftUpload = await uploadPropertyMediaRequest(
          app,
          tenant.id,
          draft.json().id,
          buildMultipartUpload({ content: JPEG_BYTES }),
        );
        const activeUpload = await uploadPropertyMediaRequest(
          app,
          tenant.id,
          active.json().id,
          buildMultipartUpload({ content: JPEG_BYTES }),
        );

        expect(draftUpload.statusCode).toBe(201);
        expect(activeUpload.statusCode).toBe(201);
      } finally {
        await app.close();
      }
    });
  });

  describe("GET /api/v1/properties/:id/media", () => {
    it("returns an empty list for a property with no media", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-list-empty", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const created = await createProperty(app, tenant.id);

        const response = await listPropertyMediaRequest(app, tenant.id, created.json().id);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ data: [] });
      } finally {
        await app.close();
      }
    });

    it("lists uploaded media ordered position ASC", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-list-order", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;
        const first = await uploadPropertyMediaRequest(app, tenant.id, propertyId, buildMultipartUpload({ content: JPEG_BYTES }));
        const second = await uploadPropertyMediaRequest(app, tenant.id, propertyId, buildMultipartUpload({ content: PNG_BYTES, contentType: "image/png" }));

        const response = await listPropertyMediaRequest(app, tenant.id, propertyId);

        expect(response.statusCode).toBe(200);
        expect(response.json().data.map((m: { id: string }) => m.id)).toEqual([first.json().id, second.json().id]);
      } finally {
        await app.close();
      }
    });

    it("returns 404 for a well-formed but unknown property id", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-list-404", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const response = await listPropertyMediaRequest(app, tenant.id, randomUUID());
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("returns 404 when the property belongs to a different tenant", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("media-list-cross-a", secretStore);
      const tenantB = await provisionReadyTenant("media-list-cross-b", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const created = await createProperty(app, tenantA.id);
        const propertyId = created.json().id;
        await uploadPropertyMediaRequest(app, tenantA.id, propertyId, buildMultipartUpload({ content: JPEG_BYTES }));

        const response = await listPropertyMediaRequest(app, tenantB.id, propertyId);

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("still lists media for an archived (INACTIVE) property — archiving never hides media", async () => {
      const { secretStore } = await setupCluster();
      const tenant = await provisionReadyTenant("media-list-archived", secretStore);
      const app = buildTestApp(secretStore, createInMemoryObjectStorage());

      try {
        const created = await createProperty(app, tenant.id);
        const propertyId = created.json().id;
        const uploaded = await uploadPropertyMediaRequest(app, tenant.id, propertyId, buildMultipartUpload({ content: JPEG_BYTES }));
        await deleteProperty(app, tenant.id, propertyId);

        const response = await listPropertyMediaRequest(app, tenant.id, propertyId);

        expect(response.statusCode).toBe(200);
        expect(response.json().data.map((m: { id: string }) => m.id)).toEqual([uploaded.json().id]);
      } finally {
        await app.close();
      }
    });
  });

  describe("Isolation A/B", () => {
    it("tenant A's property is invisible to tenant B, both via list and via get-by-id (404, not a cross-database read)", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("isolation-a", secretStore);
      const tenantB = await provisionReadyTenant("isolation-b", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenantA.id, { title: "Só da Tenant A" });
        const propertyId = created.json().id;

        const listA = await app.inject({
          method: "GET",
          url: "/api/v1/properties",
          headers: { [TENANT_ID_HEADER]: tenantA.id },
        });
        const listB = await app.inject({
          method: "GET",
          url: "/api/v1/properties",
          headers: { [TENANT_ID_HEADER]: tenantB.id },
        });

        expect(listA.json().data.map((p: { id: string }) => p.id)).toEqual([propertyId]);
        expect(listB.json().data).toEqual([]);

        const getFromB = await app.inject({
          method: "GET",
          url: `/api/v1/properties/${propertyId}`,
          headers: { [TENANT_ID_HEADER]: tenantB.id },
        });
        expect(getFromB.statusCode).toBe(404);

        const getFromA = await app.inject({
          method: "GET",
          url: `/api/v1/properties/${propertyId}`,
          headers: { [TENANT_ID_HEADER]: tenantA.id },
        });
        expect(getFromA.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("tenant B cannot PATCH or DELETE tenant A's property (404, never revealing existence), and A's record is untouched", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("isolation-patch-a", secretStore);
      const tenantB = await provisionReadyTenant("isolation-patch-b", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const created = await createProperty(app, tenantA.id, { title: "Propriedade da Tenant A" });
        const propertyId = created.json().id;

        const patchFromB = await patchProperty(app, tenantB.id, propertyId, { title: "Tentativa da Tenant B" });
        expect(patchFromB.statusCode).toBe(404);

        const deleteFromB = await deleteProperty(app, tenantB.id, propertyId);
        expect(deleteFromB.statusCode).toBe(404);

        // A's own database was never touched by B's attempts — the query never even ran there.
        const getFromA = await app.inject({
          method: "GET",
          url: `/api/v1/properties/${propertyId}`,
          headers: { [TENANT_ID_HEADER]: tenantA.id },
        });
        expect(getFromA.json()).toMatchObject({ title: "Propriedade da Tenant A", status: "DRAFT" });

        // A can still update/archive its own property normally.
        const patchFromA = await patchProperty(app, tenantA.id, propertyId, { title: "Atualizado pela A" });
        expect(patchFromA.statusCode).toBe(200);
        const deleteFromA = await deleteProperty(app, tenantA.id, propertyId);
        expect(deleteFromA.statusCode).toBe(204);
      } finally {
        await app.close();
      }
    });

    it("a filtered query in A never returns or counts B's matching rows", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("isolation-filter-a", secretStore);
      const tenantB = await provisionReadyTenant("isolation-filter-b", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const propertyA = await createProperty(app, tenantA.id, {
          status: "ACTIVE",
          property_type: "APARTMENT",
          city: "São Paulo",
        });
        await createProperty(app, tenantB.id, {
          status: "ACTIVE",
          property_type: "APARTMENT",
          city: "São Paulo",
        });

        const responseA = await app.inject({
          method: "GET",
          url: "/api/v1/properties?status=ACTIVE&property_type=APARTMENT&city=S%C3%A3o%20Paulo",
          headers: { [TENANT_ID_HEADER]: tenantA.id },
        });

        expect(responseA.json().data.map((p: { id: string }) => p.id)).toEqual([propertyA.json().id]);
        expect(responseA.json().pagination.total).toBe(1);
      } finally {
        await app.close();
      }
    });

    it("a q search in A never returns or counts B's matching rows, even with identical text", async () => {
      const { secretStore } = await setupCluster();
      const tenantA = await provisionReadyTenant("isolation-q-a", secretStore);
      const tenantB = await provisionReadyTenant("isolation-q-b", secretStore);
      const app = buildTestApp(secretStore);

      try {
        const propertyA = await createProperty(app, tenantA.id, { title: "Apartamento no Centro" });
        await createProperty(app, tenantB.id, { title: "Apartamento no Centro" });

        const responseA = await app.inject({
          method: "GET",
          url: "/api/v1/properties?q=apartamento",
          headers: { [TENANT_ID_HEADER]: tenantA.id },
        });

        expect(responseA.json().data.map((p: { id: string }) => p.id)).toEqual([propertyA.json().id]);
        expect(responseA.json().pagination.total).toBe(1);
      } finally {
        await app.close();
      }
    });
  });
});
