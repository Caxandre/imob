import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runTenantMigrations } from "../../../infrastructure/database/tenant/migrate.js";
import * as tenantSchema from "../../../infrastructure/database/tenant/schema.js";
import type { CreatePropertyInput } from "../application/property-repository.js";
import { createDrizzlePropertyRepository } from "./drizzle-property-repository.js";

/**
 * Real `postgres-tenants` (Docker Compose), never a mocked Drizzle instance (this task,
 * section 60). Deliberately lighter than the full provisioning pipeline: a repository's
 * correctness does not depend on the tenant application role's privilege boundary (already
 * proven separately by `tenant-data-plane.test.ts`) — only on a real, migrated tenant
 * database existing. Connects with the cluster admin credential directly, purely as a test
 * shortcut for standing up that database; production code never does this (ADR-003/CLAUDE.md
 * — see `drizzle-property-repository.ts` itself, which only ever receives an already-scoped
 * `TenantDatabase`).
 */
const HOST = "localhost";
const PORT = 5433;
const ADMIN_USERNAME = "postgres";
const ADMIN_PASSWORD = "postgres";

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ host: HOST, port: PORT, database: "postgres", user: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const createdFixtures: { databaseName: string; pool: Pool }[] = [];

afterEach(async () => {
  const fixtures = createdFixtures.splice(0, createdFixtures.length);
  for (const fixture of fixtures) {
    await fixture.pool.end();
  }
  await withAdminClient(async (client) => {
    for (const fixture of fixtures) {
      await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(fixture.databaseName)} WITH (FORCE)`);
    }
  });
});

async function createMigratedTenantDatabase() {
  const databaseName = `property_repo_test_${randomUUID().replaceAll("-", "")}`;
  await withAdminClient((client) => client.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`));

  await runTenantMigrations({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  const pool = new Pool({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  createdFixtures.push({ databaseName, pool });

  return drizzle(pool, { schema: tenantSchema });
}

function sampleInput(overrides: Partial<CreatePropertyInput> = {}): CreatePropertyInput {
  return {
    title: "Apartamento no Centro",
    description: "Ótima localização",
    propertyType: "APARTMENT",
    transactionType: "SALE",
    status: "DRAFT",
    price: "450000.00",
    bedrooms: 3,
    bathrooms: 2,
    parkingSpaces: 1,
    areaM2: "92.50",
    street: "Rua Exemplo",
    number: "123",
    complement: null,
    neighborhood: "Centro",
    city: "São Paulo",
    state: "SP",
    postalCode: "01000-000",
    ...overrides,
  };
}

describe("createDrizzlePropertyRepository", () => {
  it("creates a property and returns it with a generated id and timestamps", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyRepository(db);

    const property = await repository.create(sampleInput());

    expect(property.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(property).toMatchObject(sampleInput());
    expect(property.createdAt).toBeInstanceOf(Date);
    expect(property.updatedAt).toBeInstanceOf(Date);
  });

  it("findById returns the created property", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyRepository(db);

    const created = await repository.create(sampleInput({ title: "Casa com Quintal" }));

    await expect(repository.findById(created.id)).resolves.toEqual(created);
  });

  it("findById returns undefined for an id that does not exist", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyRepository(db);

    await expect(repository.findById(randomUUID())).resolves.toBeUndefined();
  });

  it("list orders results by created_at DESC, id DESC and reports the real total", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyRepository(db);

    const first = await repository.create(sampleInput({ title: "Primeiro" }));
    const second = await repository.create(sampleInput({ title: "Segundo" }));
    const third = await repository.create(sampleInput({ title: "Terceiro" }));

    const result = await repository.list({ page: 1, limit: 20 });

    expect(result.total).toBe(3);
    expect(result.data.map((property) => property.id)).toEqual([third.id, second.id, first.id]);
  });

  it("paginates correctly across pages", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyRepository(db);

    for (let i = 0; i < 5; i += 1) {
      await repository.create(sampleInput({ title: `Property ${i}` }));
    }

    const firstPage = await repository.list({ page: 1, limit: 2 });
    const secondPage = await repository.list({ page: 2, limit: 2 });
    const thirdPage = await repository.list({ page: 3, limit: 2 });

    expect(firstPage.data).toHaveLength(2);
    expect(secondPage.data).toHaveLength(2);
    expect(thirdPage.data).toHaveLength(1);
    expect(firstPage.total).toBe(5);
    expect(secondPage.total).toBe(5);

    const allIds = [...firstPage.data, ...secondPage.data, ...thirdPage.data].map((p) => p.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("list returns an empty result (never an error) when the table is empty", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyRepository(db);

    await expect(repository.list({ page: 1, limit: 20 })).resolves.toEqual({ data: [], total: 0 });
  });

  describe("update", () => {
    it("changes only the provided fields, preserves the rest, and bumps updated_at without touching created_at", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const created = await repository.create(sampleInput({ title: "Original", price: "450000.00" }));

      const updated = await repository.update(created.id, { title: "Atualizado", price: "475000.00" });

      expect(updated).toMatchObject({
        id: created.id,
        title: "Atualizado",
        price: "475000.00",
        // Untouched fields preserved exactly.
        description: created.description,
        bedrooms: created.bedrooms,
        city: created.city,
      });
      expect(updated?.createdAt).toEqual(created.createdAt);
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    });

    it("clears a nullable field when explicitly given null", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const created = await repository.create(sampleInput({ description: "Descrição original" }));
      expect(created.description).toBe("Descrição original");

      const updated = await repository.update(created.id, { description: null });

      expect(updated?.description).toBeNull();
    });

    it("leaves a field unchanged when it is not present in the input at all", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const created = await repository.create(sampleInput({ neighborhood: "Centro" }));

      const updated = await repository.update(created.id, { title: "Só o título mudou" });

      expect(updated?.neighborhood).toBe("Centro");
    });

    it("returns undefined when the property does not exist", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      await expect(repository.update(randomUUID(), { title: "x" })).resolves.toBeUndefined();
    });
  });

  describe("archive", () => {
    it("sets status to INACTIVE and bumps updated_at", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const created = await repository.create(sampleInput({ status: "ACTIVE" }));

      const archived = await repository.archive(created.id);

      expect(archived?.status).toBe("INACTIVE");
      expect(archived?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    });

    it("is idempotent — archiving an already-INACTIVE property still succeeds", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const created = await repository.create(sampleInput({ status: "ACTIVE" }));

      const first = await repository.archive(created.id);
      const second = await repository.archive(created.id);

      expect(first?.status).toBe("INACTIVE");
      expect(second?.status).toBe("INACTIVE");
    });

    it("never physically deletes the row — it remains findable after archiving", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const created = await repository.create(sampleInput());
      await repository.archive(created.id);

      await expect(repository.findById(created.id)).resolves.toMatchObject({ id: created.id, status: "INACTIVE" });
    });

    it("returns undefined when the property does not exist", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      await expect(repository.archive(randomUUID())).resolves.toBeUndefined();
    });
  });
});
