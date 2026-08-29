import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import type { TenantStatus } from "../../tenants/domain/tenant.js";
import { createDrizzleTenantDiscovery } from "./drizzle-tenant-discovery.js";

/**
 * Fixture-level tests against a real PostgreSQL Control Plane, same convention as
 * `drizzle-tenant-database-resolver.test.ts` — rows inserted directly so every eligibility
 * guard (tenant status, tenant_databases status, cluster status) can be exercised
 * independently (Prompt 031, section 52).
 */
const discovery = createDrizzleTenantDiscovery(controlPlaneDb);

beforeEach(async () => {
  await controlPlaneDb.execute(sql`TRUNCATE TABLE ${tenantDatabases}, ${tenants}, ${databaseClusters} CASCADE`);
});

afterAll(async () => {
  await controlPlanePool.end();
});

async function insertCluster(status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  const [cluster] = await controlPlaneDb
    .insert(databaseClusters)
    .values({
      name: `discovery-test-cluster-${randomUUID()}`,
      provider: "local",
      region: "local",
      status,
      host: "cluster.internal",
      port: 5432,
      secretReference: "clusters/discovery-test",
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
    .values({ slug: `discovery-test-${randomUUID()}`, name: "Discovery Test Tenant", status })
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
}) {
  const [tenantDatabase] = await controlPlaneDb
    .insert(tenantDatabases)
    .values({
      tenantId: input.tenantId,
      clusterId: input.clusterId,
      databaseName: `tenant_${input.tenantId.replaceAll("-", "")}`,
      secretReference: `tenant-databases/${input.tenantId}`,
      status: input.status ?? "READY",
    })
    .returning();
  if (!tenantDatabase) {
    throw new Error("tenant_databases insert returned no row");
  }
  return tenantDatabase;
}

/** Fully eligible: READY tenant + READY tenant_databases + ACTIVE cluster. */
async function insertEligibleTenant() {
  const cluster = await insertCluster("ACTIVE");
  const tenant = await insertTenant("READY");
  await insertTenantDatabase({ tenantId: tenant.id, clusterId: cluster.id });
  return tenant;
}

describe("createDrizzleTenantDiscovery", () => {
  it("returns a tenant that is READY with a READY database on an ACTIVE cluster", async () => {
    const tenant = await insertEligibleTenant();

    await expect(discovery.listReadyTenantIds({ limit: 10 })).resolves.toEqual([tenant.id]);
  });

  it.each<TenantStatus>(["PROVISIONING", "FAILED", "SUSPENDED"])(
    "excludes a tenant whose status is %s",
    async (status) => {
      const cluster = await insertCluster("ACTIVE");
      const tenant = await insertTenant(status);
      await insertTenantDatabase({ tenantId: tenant.id, clusterId: cluster.id });

      await expect(discovery.listReadyTenantIds({ limit: 10 })).resolves.toEqual([]);
    },
  );

  it("excludes a READY tenant with no tenant_databases row at all", async () => {
    await insertTenant("READY");

    await expect(discovery.listReadyTenantIds({ limit: 10 })).resolves.toEqual([]);
  });

  it.each<"PROVISIONING" | "FAILED">(["PROVISIONING", "FAILED"])(
    "excludes a tenant whose tenant_databases.status is %s",
    async (status) => {
      const cluster = await insertCluster("ACTIVE");
      const tenant = await insertTenant("READY");
      await insertTenantDatabase({ tenantId: tenant.id, clusterId: cluster.id, status });

      await expect(discovery.listReadyTenantIds({ limit: 10 })).resolves.toEqual([]);
    },
  );

  it("excludes a tenant whose registered cluster is INACTIVE", async () => {
    const cluster = await insertCluster("INACTIVE");
    const tenant = await insertTenant("READY");
    await insertTenantDatabase({ tenantId: tenant.id, clusterId: cluster.id });

    await expect(discovery.listReadyTenantIds({ limit: 10 })).resolves.toEqual([]);
  });

  it("orders results by tenant id ascending, deterministically", async () => {
    const a = await insertEligibleTenant();
    const b = await insertEligibleTenant();
    const c = await insertEligibleTenant();

    const result = await discovery.listReadyTenantIds({ limit: 10 });

    expect(result).toEqual([a.id, b.id, c.id].sort());
  });

  it("paginates with a stable, resumable cursor covering every eligible tenant exactly once", async () => {
    const tenantIds: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const tenant = await insertEligibleTenant();
      tenantIds.push(tenant.id);
    }
    const sortedIds = [...tenantIds].sort();

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await discovery.listReadyTenantIds({ after: cursor, limit: 3 });
      if (page.length === 0) {
        break;
      }
      collected.push(...page);
      cursor = page[page.length - 1];
    }

    expect(collected).toEqual(sortedIds);
  });

  it("respects the limit", async () => {
    await insertEligibleTenant();
    await insertEligibleTenant();
    await insertEligibleTenant();

    await expect(discovery.listReadyTenantIds({ limit: 2 })).resolves.toHaveLength(2);
  });
});
