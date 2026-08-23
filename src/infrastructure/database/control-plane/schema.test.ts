import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "./client.js";
import { CONTROL_PLANE_MIGRATIONS_FOLDER } from "./migrations-folder.js";
import { databaseClusters, provisioningJobs, tenantDatabases, tenants } from "./schema.js";

// PostgreSQL SQLSTATE codes for the integrity violations exercised below.
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

interface PostgresError {
  code: string;
  constraint?: string;
}

function isPostgresError(value: unknown): value is Error & PostgresError {
  return value instanceof Error && typeof (value as Partial<PostgresError>).code === "string";
}

/**
 * Drizzle wraps driver errors, so the SQLSTATE code and constraint name live somewhere in
 * the `cause` chain rather than in the top-level message.
 */
async function expectViolation(operation: () => Promise<unknown>): Promise<PostgresError> {
  let rejection: unknown;

  try {
    await operation();
  } catch (error) {
    rejection = error;
  }

  expect(rejection, "expected the operation to be rejected").toBeDefined();

  let current: unknown = rejection;
  while (current instanceof Error) {
    if (isPostgresError(current)) {
      return current;
    }
    current = current.cause;
  }

  throw new Error(`Rejection was not a PostgreSQL error: ${String(rejection)}`);
}

async function insertTenant(slug: string) {
  const [tenant] = await controlPlaneDb
    .insert(tenants)
    .values({ slug, name: `Tenant ${slug}` })
    .returning();

  if (!tenant) {
    throw new Error("tenant insert returned no row");
  }

  return tenant;
}

async function insertCluster(name: string) {
  const [cluster] = await controlPlaneDb
    .insert(databaseClusters)
    .values({
      name,
      provider: "local",
      region: "local",
      secretReference: `database-clusters/${name}`,
    })
    .returning();

  if (!cluster) {
    throw new Error("cluster insert returned no row");
  }

  return cluster;
}

beforeEach(async () => {
  await controlPlaneDb.execute(
    sql`TRUNCATE TABLE ${provisioningJobs}, ${tenantDatabases}, ${tenants}, ${databaseClusters} CASCADE`,
  );
});

afterAll(async () => {
  await controlPlanePool.end();
});

describe("control plane migrations", () => {
  it("creates every table on an empty database", async () => {
    const result = await controlPlaneDb.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );

    const tableNames = result.rows.map((row) => row.table_name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "tenants",
        "database_clusters",
        "tenant_databases",
        "provisioning_jobs",
      ]),
    );
  });

  it("creates every enum type", async () => {
    const result = await controlPlaneDb.execute<{ typname: string }>(
      sql`SELECT typname FROM pg_type WHERE typtype = 'e'`,
    );

    expect(result.rows.map((row) => row.typname)).toEqual(
      expect.arrayContaining([
        "tenant_status",
        "database_cluster_status",
        "tenant_database_status",
        "provisioning_job_type",
        "provisioning_job_status",
      ]),
    );
  });

  it("is safe to apply again against an already migrated database", async () => {
    await expect(
      migrate(controlPlaneDb, { migrationsFolder: CONTROL_PLANE_MIGRATIONS_FOLDER }),
    ).resolves.not.toThrow();
  });
});

describe("tenants", () => {
  it("creates a tenant with generated id, default status and timestamps", async () => {
    const tenant = await insertTenant("acme");

    expect(tenant.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(tenant.slug).toBe("acme");
    expect(tenant.name).toBe("Tenant acme");
    expect(tenant.status).toBe("PROVISIONING");
    expect(tenant.createdAt).toBeInstanceOf(Date);
    expect(tenant.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects two tenants with the same slug", async () => {
    await insertTenant("duplicated");

    const error = await expectViolation(() => insertTenant("duplicated"));

    expect(error.code).toBe(UNIQUE_VIOLATION);
    expect(error.constraint).toBe("tenants_slug_unique");
  });
});

describe("tenant_databases", () => {
  it("rejects a second database for the same tenant", async () => {
    const tenant = await insertTenant("single-db");
    const clusterA = await insertCluster("cluster-a");
    const clusterB = await insertCluster("cluster-b");

    await controlPlaneDb.insert(tenantDatabases).values({
      tenantId: tenant.id,
      clusterId: clusterA.id,
      databaseName: "tenant_single_db",
      secretReference: "tenant-databases/tenant_single_db",
    });

    const error = await expectViolation(() =>
      controlPlaneDb.insert(tenantDatabases).values({
        tenantId: tenant.id,
        clusterId: clusterB.id,
        databaseName: "tenant_single_db_second",
        secretReference: "tenant-databases/tenant_single_db_second",
      }),
    );

    expect(error.code).toBe(UNIQUE_VIOLATION);
    expect(error.constraint).toBe("tenant_databases_tenant_id_unique");
  });

  it("allows the same database name on different clusters", async () => {
    const tenantOne = await insertTenant("tenant-one");
    const tenantTwo = await insertTenant("tenant-two");
    const clusterA = await insertCluster("cluster-a");
    const clusterB = await insertCluster("cluster-b");

    await controlPlaneDb.insert(tenantDatabases).values({
      tenantId: tenantOne.id,
      clusterId: clusterA.id,
      databaseName: "tenant_example",
      secretReference: "tenant-databases/a/tenant_example",
    });

    await expect(
      controlPlaneDb.insert(tenantDatabases).values({
        tenantId: tenantTwo.id,
        clusterId: clusterB.id,
        databaseName: "tenant_example",
        secretReference: "tenant-databases/b/tenant_example",
      }),
    ).resolves.not.toThrow();
  });

  it("rejects the same database name twice on the same cluster", async () => {
    const tenantOne = await insertTenant("tenant-one");
    const tenantTwo = await insertTenant("tenant-two");
    const cluster = await insertCluster("cluster-a");

    await controlPlaneDb.insert(tenantDatabases).values({
      tenantId: tenantOne.id,
      clusterId: cluster.id,
      databaseName: "tenant_example",
      secretReference: "tenant-databases/a/tenant_example",
    });

    const error = await expectViolation(() =>
      controlPlaneDb.insert(tenantDatabases).values({
        tenantId: tenantTwo.id,
        clusterId: cluster.id,
        databaseName: "tenant_example",
        secretReference: "tenant-databases/a/tenant_example",
      }),
    );

    expect(error.code).toBe(UNIQUE_VIOLATION);
    expect(error.constraint).toBe("tenant_databases_cluster_id_database_name_unique");
  });

  it("rejects a database pointing at a non-existent tenant", async () => {
    const cluster = await insertCluster("cluster-a");

    const error = await expectViolation(() =>
      controlPlaneDb.insert(tenantDatabases).values({
        tenantId: "00000000-0000-0000-0000-000000000000",
        clusterId: cluster.id,
        databaseName: "tenant_orphan",
        secretReference: "tenant-databases/tenant_orphan",
      }),
    );

    expect(error.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(error.constraint).toBe("tenant_databases_tenant_id_tenants_id_fk");
  });

  it("rejects a database pointing at a non-existent cluster", async () => {
    const tenant = await insertTenant("orphan-cluster");

    const error = await expectViolation(() =>
      controlPlaneDb.insert(tenantDatabases).values({
        tenantId: tenant.id,
        clusterId: "00000000-0000-0000-0000-000000000000",
        databaseName: "tenant_orphan",
        secretReference: "tenant-databases/tenant_orphan",
      }),
    );

    expect(error.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(error.constraint).toBe("tenant_databases_cluster_id_database_clusters_id_fk");
  });

  it("rejects a negative schema_version", async () => {
    const tenant = await insertTenant("negative-version");
    const cluster = await insertCluster("cluster-a");

    const error = await expectViolation(() =>
      controlPlaneDb.insert(tenantDatabases).values({
        tenantId: tenant.id,
        clusterId: cluster.id,
        databaseName: "tenant_negative",
        secretReference: "tenant-databases/tenant_negative",
        schemaVersion: -1,
      }),
    );

    expect(error.code).toBe(CHECK_VIOLATION);
    expect(error.constraint).toBe("tenant_databases_schema_version_non_negative");
  });
});

describe("provisioning_jobs", () => {
  it("creates a job with default status and attempts", async () => {
    const tenant = await insertTenant("job-tenant");

    const [job] = await controlPlaneDb
      .insert(provisioningJobs)
      .values({ tenantId: tenant.id, type: "CREATE_DATABASE" })
      .returning();

    expect(job?.status).toBe("PENDING");
    expect(job?.attempts).toBe(0);
    expect(job?.currentStep).toBeNull();
    expect(job?.errorMessage).toBeNull();
    expect(job?.startedAt).toBeNull();
    expect(job?.finishedAt).toBeNull();
  });

  it("rejects a job pointing at a non-existent tenant", async () => {
    const error = await expectViolation(() =>
      controlPlaneDb.insert(provisioningJobs).values({
        tenantId: "00000000-0000-0000-0000-000000000000",
        type: "CREATE_DATABASE",
      }),
    );

    expect(error.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(error.constraint).toBe("provisioning_jobs_tenant_id_tenants_id_fk");
  });

  it("rejects negative attempts", async () => {
    const tenant = await insertTenant("negative-attempts");

    const error = await expectViolation(() =>
      controlPlaneDb.insert(provisioningJobs).values({
        tenantId: tenant.id,
        type: "CREATE_DATABASE",
        attempts: -1,
      }),
    );

    expect(error.code).toBe(CHECK_VIOLATION);
    expect(error.constraint).toBe("provisioning_jobs_attempts_non_negative");
  });
});

describe("foreign key deletions", () => {
  it("prevents deleting a tenant that still owns a database", async () => {
    const tenant = await insertTenant("referenced");
    const cluster = await insertCluster("cluster-a");

    await controlPlaneDb.insert(tenantDatabases).values({
      tenantId: tenant.id,
      clusterId: cluster.id,
      databaseName: "tenant_referenced",
      secretReference: "tenant-databases/tenant_referenced",
    });

    const error = await expectViolation(() =>
      controlPlaneDb.execute(sql`DELETE FROM ${tenants} WHERE id = ${tenant.id}`),
    );

    expect(error.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(error.constraint).toBe("tenant_databases_tenant_id_tenants_id_fk");
  });
});
