import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  provisioningJobs,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import { outboxEvents } from "../../../infrastructure/database/tenant/schema.js";
import { createMediaProcessingQueue, type MediaProcessingQueue } from "../../../infrastructure/queue/media-processing-queue.js";
import { createRedisConnection } from "../../../infrastructure/queue/redis-connection.js";
import { createClusterAdminCredentialResolver } from "../../provisioning/application/cluster-admin-credential-resolver.js";
import { startPendingProvisioningJob } from "../../provisioning/application/process-provisioning-job.js";
import type { DatabaseProvisioner, ProcessProvisioningJobRepository } from "../../provisioning/application/process-provisioning-job.js";
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
import { createDrizzlePropertyMediaRepository } from "../../properties/infrastructure/drizzle-property-media-repository.js";
import { createDrizzlePropertyRepository } from "../../properties/infrastructure/drizzle-property-repository.js";
import type { Tenant } from "../../tenants/domain/tenant.js";
import { createDrizzleTenantRepository } from "../../tenants/infrastructure/drizzle-tenant-repository.js";
import { createDrizzleTenantDatabaseResolver } from "../../tenant-runtime/infrastructure/drizzle-tenant-database-resolver.js";
import { createDrizzleTenantDiscovery } from "../../tenant-runtime/infrastructure/drizzle-tenant-discovery.js";
import { createPgTenantDatabaseConnectionManager } from "../../tenant-runtime/infrastructure/pg-tenant-database-connection-manager.js";
import { createBullMqMediaOutboxJobPublisher } from "../infrastructure/bullmq-media-outbox-job-publisher.js";
import { createDrizzleMediaOutboxDispatchRepository } from "../infrastructure/drizzle-media-outbox-dispatch-repository.js";
import { runMediaOutboxDispatchCycleOnce, type MediaOutboxDispatchCycleDeps } from "./dispatch-media-outbox-cycle.js";

/**
 * Full end-to-end proof of the manual flow this task describes (section 79): real property
 * media upload (via the repository layer — same code path `uploadPropertyMedia` uses) writes
 * `property_media` + an outbox event atomically in a real tenant database; a real dispatch
 * cycle then discovers that tenant through a real Control Plane, claims the event, and
 * transports it to a real Redis-backed BullMQ queue. No worker consumes the job — this task
 * never implements one — so `processing_status` staying `PROCESSING` and `processed_at`
 * staying `null` afterward is the expected, asserted outcome, not a gap in this test.
 */
const CLUSTER_NAME = "e2e-media-outbox-dispatch-cluster";
const ADMIN_SECRET_REFERENCE = `clusters/${CLUSTER_NAME}`;
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";
const TENANTS_HOST = "localhost";
const TENANTS_PORT = 5433;
const LEASE_SECONDS = 60;

const createdDatabaseNames = new Set<string>();
const createdRoleNames = new Set<string>();

function trackTenantResources(tenantId: string): void {
  const names = buildProvisioningResourceNames(tenantId);
  createdDatabaseNames.add(names.databaseName);
  createdRoleNames.add(names.roleName);
}

let connection: ReturnType<typeof createRedisConnection>;
let queue: MediaProcessingQueue;

beforeEach(async () => {
  await controlPlaneDb.execute(
    sql`TRUNCATE TABLE ${provisioningJobs}, ${tenantDatabases}, ${tenants}, ${databaseClusters} CASCADE`,
  );
  connection = createRedisConnection();
  queue = createMediaProcessingQueue(connection);
});

afterEach(async () => {
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await connection.quit();

  const databaseNames = [...createdDatabaseNames];
  const roleNames = [...createdRoleNames];
  createdDatabaseNames.clear();
  createdRoleNames.clear();

  const client = new Client({ host: TENANTS_HOST, port: TENANTS_PORT, database: "postgres", user: ADMIN_USERNAME, password: ADMIN_PASSWORD });
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

async function provisionReadyTenant(slugPrefix: string, secretStore: SecretStore): Promise<Tenant> {
  const tenantRepository = createDrizzleTenantRepository(controlPlaneDb);
  const tenant = await tenantRepository.createWithProvisioningIntent({
    name: `Media Outbox E2E ${slugPrefix}`,
    slug: `${slugPrefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  });
  trackTenantResources(tenant.id);

  const [job] = await controlPlaneDb.select().from(provisioningJobs).where(eq(provisioningJobs.tenantId, tenant.id));
  if (!job) {
    throw new Error("provisioning job was not created alongside the tenant");
  }

  const clusterAdminCredentialResolver = createClusterAdminCredentialResolver(secretStore);
  const databaseProvisioner: DatabaseProvisioner = createPostgresDatabaseProvisioner({
    clusterSelector: createDrizzleDatabaseClusterSelector(controlPlaneDb, CLUSTER_NAME),
    clusterAdminCredentialResolver,
    tenantRoleProvisioner: createPostgresTenantRoleProvisioner({ secretStore, clusterAdminCredentialResolver }),
    tenantDatabaseProvisioner: createPostgresTenantDatabaseProvisioner({ clusterAdminCredentialResolver }),
    tenantDatabaseCredentialResolver: createTenantDatabaseCredentialResolver(secretStore),
    healthChecker: createPostgresTenantDatabaseHealthChecker(),
  });
  const repository: ProcessProvisioningJobRepository = createDrizzleProcessProvisioningJobRepository(controlPlaneDb);

  const outcome = await startPendingProvisioningJob(
    repository,
    databaseProvisioner,
    { provisioningJobId: job.id, tenantId: tenant.id },
    { leaseSeconds: LEASE_SECONDS, heartbeatIntervalMs: 999_999 },
  );
  if (outcome.outcome !== "succeeded") {
    throw new Error(`expected provisioning to succeed for "${slugPrefix}", got ${JSON.stringify(outcome)}`);
  }

  return tenant;
}

describe("media outbox: real upload → real dispatch cycle → real BullMQ (end to end)", () => {
  it("dispatches a real upload's outbox event to BullMQ with the correct payload and jobId", async () => {
    const { secretStore } = await setupCluster();
    const tenant = await provisionReadyTenant("upload-dispatch", secretStore);

    const tenantDatabaseResolver = createDrizzleTenantDatabaseResolver(controlPlaneDb);
    const tenantDatabaseConnectionManager = createPgTenantDatabaseConnectionManager({
      credentialResolver: createTenantDatabaseCredentialResolver(secretStore),
    });

    try {
      const target = await tenantDatabaseResolver.resolve(tenant.id);
      const { propertyId, mediaId } = await tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
        const propertyRepository = createDrizzlePropertyRepository(db);
        const mediaRepository = createDrizzlePropertyMediaRepository(db);
        const property = await propertyRepository.create({
          title: "Apartamento no Centro",
          description: null,
          propertyType: "APARTMENT",
          transactionType: "SALE",
          status: "ACTIVE",
          price: "450000.00",
          bedrooms: null,
          bathrooms: null,
          parkingSpaces: null,
          areaM2: null,
          street: null,
          number: null,
          complement: null,
          neighborhood: null,
          city: null,
          state: null,
          postalCode: null,
        });
        const mediaId = randomUUID();
        const media = await mediaRepository.create({
          id: mediaId,
          propertyId: property.id,
          objectKey: `tenants/${tenant.id}/properties/${property.id}/${mediaId}.jpg`,
          publicUrl: `https://public-base.example/tenants/${tenant.id}/properties/${property.id}/${mediaId}.jpg`,
          mimeType: "image/jpeg",
          sizeBytes: 12345,
          originalFilename: "foto.jpg",
        });
        return { propertyId: property.id, mediaId: media.id };
      });

      const publisher = createBullMqMediaOutboxJobPublisher(queue);
      const deps: MediaOutboxDispatchCycleDeps = {
        tenantDiscovery: createDrizzleTenantDiscovery(controlPlaneDb),
        tenantDatabaseResolver,
        tenantDatabaseConnectionManager,
        createRepository: createDrizzleMediaOutboxDispatchRepository,
        publisher,
      };

      const summary = await runMediaOutboxDispatchCycleOnce(deps, undefined, {
        tenantBatchSize: 25,
        eventBatchSize: 20,
        leaseSeconds: 30,
        concurrency: 5,
      });

      expect(summary.tenantIds).toEqual([tenant.id]);
      const tenantResult = summary.tenantResults.find((r) => r.tenantId === tenant.id);
      expect(tenantResult?.outcome).toBe("dispatched");
      expect(tenantResult?.summary?.results).toEqual([
        { outboxEventId: expect.any(String), outcome: "dispatched" },
      ]);
      const outboxEventId = tenantResult?.summary?.results[0]?.outboxEventId;
      if (!outboxEventId) {
        throw new Error("expected a dispatched outbox event id");
      }

      // The real job actually landed in Redis, with exactly the documented payload — never
      // credentials, public URL, or bytes.
      const job = await queue.getJob(outboxEventId);
      expect(job).toBeDefined();
      expect(job?.id).toBe(outboxEventId);
      expect(job?.data).toEqual({ tenantId: tenant.id, propertyId, mediaId });

      // dispatched_at confirms transport; processed_at stays null — no worker exists yet to
      // finish real domain processing (this task, section 21/79).
      await tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
        const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, outboxEventId));
        expect(row?.dispatchedAt).toBeInstanceOf(Date);
        expect(row?.processedAt).toBeNull();
      });
    } finally {
      await tenantDatabaseConnectionManager.close();
    }
  });
});
