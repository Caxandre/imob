import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { controlPlaneDb, controlPlanePool } from "../../../infrastructure/database/control-plane/client.js";
import { databaseClusters } from "../../../infrastructure/database/control-plane/schema.js";
import { DatabaseClusterNotAvailableError } from "../application/database-cluster-selector.js";
import { createDrizzleDatabaseClusterSelector } from "./drizzle-database-cluster-selector.js";

const ANY_TENANT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

async function insertCluster(overrides: {
  name: string;
  status?: "ACTIVE" | "INACTIVE";
}) {
  const [cluster] = await controlPlaneDb
    .insert(databaseClusters)
    .values({
      name: overrides.name,
      status: overrides.status ?? "ACTIVE",
      provider: "aws-rds",
      region: "us-east-1",
      secretReference: `clusters/${overrides.name}`,
    })
    .returning();

  if (!cluster) {
    throw new Error("database cluster insert returned no row");
  }

  return cluster;
}

beforeEach(async () => {
  await controlPlaneDb.execute(sql`TRUNCATE TABLE ${databaseClusters} CASCADE`);
});

afterAll(async () => {
  await controlPlanePool.end();
});

describe("createDrizzleDatabaseClusterSelector", () => {
  it("selects the configured cluster when it is ACTIVE", async () => {
    const cluster = await insertCluster({ name: "primary" });
    const selector = createDrizzleDatabaseClusterSelector(controlPlaneDb, "primary");

    const result = await selector.selectClusterFor(ANY_TENANT_ID);

    expect(result).toEqual({
      id: cluster.id,
      name: "primary",
      provider: "aws-rds",
      region: "us-east-1",
      secretReference: "clusters/primary",
    });
  });

  it("throws DatabaseClusterNotAvailableError when no cluster with that name exists", async () => {
    const selector = createDrizzleDatabaseClusterSelector(controlPlaneDb, "missing");

    await expect(selector.selectClusterFor(ANY_TENANT_ID)).rejects.toThrow(
      DatabaseClusterNotAvailableError,
    );
  });

  it("throws DatabaseClusterNotAvailableError when the matching cluster is INACTIVE", async () => {
    await insertCluster({ name: "dormant", status: "INACTIVE" });
    const selector = createDrizzleDatabaseClusterSelector(controlPlaneDb, "dormant");

    await expect(selector.selectClusterFor(ANY_TENANT_ID)).rejects.toThrow(
      DatabaseClusterNotAvailableError,
    );
  });

  it("selects only the configured cluster when multiple ACTIVE clusters exist", async () => {
    await insertCluster({ name: "other-active" });
    const target = await insertCluster({ name: "target" });
    const selector = createDrizzleDatabaseClusterSelector(controlPlaneDb, "target");

    const result = await selector.selectClusterFor(ANY_TENANT_ID);

    expect(result.id).toBe(target.id);
    expect(result.name).toBe("target");
  });

  it("never leaks credential details in the not-available error message", async () => {
    const selector = createDrizzleDatabaseClusterSelector(controlPlaneDb, "missing-cluster");

    await expect(selector.selectClusterFor(ANY_TENANT_ID)).rejects.toThrow(
      'No ACTIVE database cluster named "missing-cluster" is available',
    );
  });
});
