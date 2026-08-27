import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import type { TenantStatus } from "../../tenants/domain/tenant.js";
import {
  TenantDatabaseNotAvailableError,
  TenantDatabaseRuntimeConfigurationError,
  TenantNotReadyError,
} from "../application/tenant-database-resolver.js";
import { createDrizzleTenantDatabaseResolver } from "./drizzle-tenant-database-resolver.js";

/**
 * Fixture-level tests against a real PostgreSQL Control Plane: rows are inserted directly
 * (never through the provisioning pipeline) so every guard — tenant status, tenant_databases
 * status, cluster status — can be exercised independently and cheaply, including states the
 * normal provisioning flow can never produce on its own (e.g. a READY tenant with no
 * tenant_databases row at all), per this task's section 45.
 */
const resolver = createDrizzleTenantDatabaseResolver(controlPlaneDb);

beforeEach(async () => {
  await controlPlaneDb.execute(
    sql`TRUNCATE TABLE ${tenantDatabases}, ${tenants}, ${databaseClusters} CASCADE`,
  );
});

afterAll(async () => {
  await controlPlanePool.end();
});

async function insertCluster(status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  const [cluster] = await controlPlaneDb
    .insert(databaseClusters)
    .values({
      name: `resolver-test-cluster-${randomUUID()}`,
      provider: "local",
      region: "local",
      status,
      host: "cluster.internal",
      port: 5432,
      secretReference: "clusters/resolver-test",
    })
    .returning();
  if (!cluster) {
    throw new Error("cluster insert returned no row");
  }
  return cluster;
}

async function insertTenant(status: TenantStatus) {
  const [tenant] = await controlPlaneDb
    .insert(tenants)
    .values({ slug: `resolver-test-${randomUUID()}`, name: "Resolver Test Tenant", status })
    .returning();
  if (!tenant) {
    throw new Error("tenant insert returned no row");
  }
  return tenant;
}

async function insertTenantDatabase(input: {
  tenantId: string;
  clusterId: string;
  status?: "PROVISIONING" | "READY" | "FAILED";
  schemaVersion?: number;
}) {
  const [tenantDatabase] = await controlPlaneDb
    .insert(tenantDatabases)
    .values({
      tenantId: input.tenantId,
      clusterId: input.clusterId,
      databaseName: `tenant_${input.tenantId.replaceAll("-", "")}`,
      secretReference: `tenant-databases/${input.tenantId}`,
      schemaVersion: input.schemaVersion ?? 3,
      status: input.status ?? "READY",
    })
    .returning();
  if (!tenantDatabase) {
    throw new Error("tenant_databases insert returned no row");
  }
  return tenantDatabase;
}

describe("createDrizzleTenantDatabaseResolver", () => {
  it("resolves a full TenantDatabaseTarget for a READY tenant with a READY database on an ACTIVE cluster", async () => {
    const cluster = await insertCluster("ACTIVE");
    const tenant = await insertTenant("READY");
    const tenantDatabase = await insertTenantDatabase({
      tenantId: tenant.id,
      clusterId: cluster.id,
      schemaVersion: 7,
    });

    await expect(resolver.resolve(tenant.id)).resolves.toEqual({
      tenantId: tenant.id,
      clusterId: cluster.id,
      host: cluster.host,
      port: cluster.port,
      databaseName: tenantDatabase.databaseName,
      secretReference: tenantDatabase.secretReference,
      schemaVersion: 7,
    });
  });

  it("throws TenantNotReadyError when no tenant with that id exists", async () => {
    const tenantId = randomUUID();

    await expect(resolver.resolve(tenantId)).rejects.toBeInstanceOf(TenantNotReadyError);
    await expect(resolver.resolve(tenantId)).rejects.toMatchObject({ tenantId, status: "NOT_FOUND" });
  });

  it.each<TenantStatus>(["PROVISIONING", "FAILED", "SUSPENDED"])(
    "throws TenantNotReadyError when tenant.status is %s",
    async (status) => {
      const tenant = await insertTenant(status);

      await expect(resolver.resolve(tenant.id)).rejects.toBeInstanceOf(TenantNotReadyError);
      await expect(resolver.resolve(tenant.id)).rejects.toMatchObject({ tenantId: tenant.id, status });
    },
  );

  it("throws TenantDatabaseNotAvailableError when a READY tenant has no tenant_databases row", async () => {
    const tenant = await insertTenant("READY");

    await expect(resolver.resolve(tenant.id)).rejects.toBeInstanceOf(TenantDatabaseNotAvailableError);
    await expect(resolver.resolve(tenant.id)).rejects.toMatchObject({ tenantId: tenant.id, status: "MISSING" });
  });

  it.each<"PROVISIONING" | "FAILED">(["PROVISIONING", "FAILED"])(
    "throws TenantDatabaseNotAvailableError when tenant_databases.status is %s",
    async (status) => {
      const cluster = await insertCluster("ACTIVE");
      const tenant = await insertTenant("READY");
      await insertTenantDatabase({ tenantId: tenant.id, clusterId: cluster.id, status });

      await expect(resolver.resolve(tenant.id)).rejects.toBeInstanceOf(TenantDatabaseNotAvailableError);
      await expect(resolver.resolve(tenant.id)).rejects.toMatchObject({ tenantId: tenant.id, status });
    },
  );

  it("throws TenantDatabaseRuntimeConfigurationError when the registered cluster is INACTIVE", async () => {
    const cluster = await insertCluster("INACTIVE");
    const tenant = await insertTenant("READY");
    await insertTenantDatabase({ tenantId: tenant.id, clusterId: cluster.id });

    await expect(resolver.resolve(tenant.id)).rejects.toBeInstanceOf(TenantDatabaseRuntimeConfigurationError);
  });

  it("re-checks Control Plane state on every call — a tenant suspended after an earlier successful resolve is refused", async () => {
    const cluster = await insertCluster("ACTIVE");
    const tenant = await insertTenant("READY");
    await insertTenantDatabase({ tenantId: tenant.id, clusterId: cluster.id });

    await expect(resolver.resolve(tenant.id)).resolves.toMatchObject({ tenantId: tenant.id });

    await controlPlaneDb.update(tenants).set({ status: "SUSPENDED" }).where(eq(tenants.id, tenant.id));

    await expect(resolver.resolve(tenant.id)).rejects.toBeInstanceOf(TenantNotReadyError);
  });
});
