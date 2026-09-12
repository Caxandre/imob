import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runTenantMigrations } from "../../../infrastructure/database/tenant/migrate.js";
import * as tenantSchema from "../../../infrastructure/database/tenant/schema.js";
import type { CreatePropertyInput } from "../../properties/application/property-repository.js";
import { createDrizzlePropertyRepository } from "../../properties/infrastructure/drizzle-property-repository.js";
import type { CreateLeadInput, ListLeadsInput } from "../application/lead-repository.js";
import { createDrizzleLeadRepository } from "./drizzle-lead-repository.js";

/**
 * Real `postgres-tenants` (Docker Compose), never a mocked Drizzle instance — same lightweight
 * pattern as `drizzle-property-repository.test.ts`: a fresh, really-migrated tenant database per
 * test, connected with the cluster admin credential purely as a test shortcut (production code
 * never does this).
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
  const databaseName = `lead_repo_test_${randomUUID().replaceAll("-", "")}`;
  await withAdminClient((client) => client.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`));

  await runTenantMigrations({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  const pool = new Pool({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  createdFixtures.push({ databaseName, pool });

  return drizzle(pool, { schema: tenantSchema });
}

function listInput(overrides: Partial<ListLeadsInput> = {}): ListLeadsInput {
  return { page: 1, limit: 20, filters: {}, sort: "created_at", order: "desc", ...overrides };
}

function sampleLeadInput(overrides: Partial<CreateLeadInput> = {}): CreateLeadInput {
  return {
    propertyId: null,
    name: "Maria Souza",
    email: "maria@example.com",
    phone: null,
    source: "MANUAL",
    message: "Tenho interesse neste apartamento.",
    notes: null,
    ...overrides,
  };
}

function samplePropertyInput(overrides: Partial<CreatePropertyInput> = {}): CreatePropertyInput {
  return {
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
    ...overrides,
  };
}

describe("createDrizzleLeadRepository", () => {
  it("creates a lead and returns it with a generated id, default status/source, and timestamps", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);

    const lead = await repository.create(sampleLeadInput());

    expect(lead.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lead).toMatchObject({ name: "Maria Souza", email: "maria@example.com", status: "NEW", source: "MANUAL" });
    expect(lead.createdAt).toBeInstanceOf(Date);
    expect(lead.updatedAt).toBeInstanceOf(Date);
  });

  it("creates a lead with only a phone (no email)", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);

    const lead = await repository.create(sampleLeadInput({ email: null, phone: "11999990000" }));

    expect(lead).toMatchObject({ email: null, phone: "11999990000" });
  });

  it("rejects at the database level a lead with neither email nor phone (CHECK constraint)", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);

    await expect(repository.create(sampleLeadInput({ email: null, phone: null }))).rejects.toThrow();
  });

  it("creates a lead associated with a real property in the same tenant database", async () => {
    const db = await createMigratedTenantDatabase();
    const propertyRepository = createDrizzlePropertyRepository(db);
    const leadRepository = createDrizzleLeadRepository(db);
    const property = await propertyRepository.create(samplePropertyInput());

    const lead = await leadRepository.create(sampleLeadInput({ propertyId: property.id }));

    expect(lead.propertyId).toBe(property.id);
  });

  it("findById returns the lead with its property summary when associated", async () => {
    const db = await createMigratedTenantDatabase();
    const propertyRepository = createDrizzlePropertyRepository(db);
    const leadRepository = createDrizzleLeadRepository(db);
    const property = await propertyRepository.create(samplePropertyInput({ title: "Casa na Praia" }));
    const created = await leadRepository.create(sampleLeadInput({ propertyId: property.id }));

    const found = await leadRepository.findById(created.id);

    expect(found?.property).toEqual({ id: property.id, title: "Casa na Praia", status: "ACTIVE" });
  });

  it("findById returns property: null for a generic lead", async () => {
    const db = await createMigratedTenantDatabase();
    const leadRepository = createDrizzleLeadRepository(db);
    const created = await leadRepository.create(sampleLeadInput());

    const found = await leadRepository.findById(created.id);

    expect(found?.property).toBeNull();
  });

  it("findById returns undefined for a missing id", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);

    await expect(repository.findById(randomUUID())).resolves.toBeUndefined();
  });

  it("lists leads with pagination, default ordering (created_at desc, id desc), and total", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);
    const first = await repository.create(sampleLeadInput({ name: "Primeiro" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await repository.create(sampleLeadInput({ name: "Segundo" }));

    const result = await repository.list(listInput());

    expect(result.total).toBe(2);
    expect(result.data.map((lead) => lead.id)).toEqual([second.id, first.id]);
  });

  it("filters by status", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);
    const lead = await repository.create(sampleLeadInput());
    await repository.update(lead.id, { status: "CONTACTED" });
    await repository.create(sampleLeadInput({ name: "Outro" }));

    const result = await repository.list(listInput({ filters: { status: "CONTACTED" } }));

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(lead.id);
  });

  it("filters by source", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);
    await repository.create(sampleLeadInput({ source: "WEBSITE" }));
    await repository.create(sampleLeadInput({ source: "MANUAL" }));

    const result = await repository.list(listInput({ filters: { source: "WEBSITE" } }));

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.source).toBe("WEBSITE");
  });

  it("filters by property_id", async () => {
    const db = await createMigratedTenantDatabase();
    const propertyRepository = createDrizzlePropertyRepository(db);
    const leadRepository = createDrizzleLeadRepository(db);
    const property = await propertyRepository.create(samplePropertyInput());
    const linked = await leadRepository.create(sampleLeadInput({ propertyId: property.id }));
    await leadRepository.create(sampleLeadInput());

    const result = await leadRepository.list(listInput({ filters: { propertyId: property.id } }));

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(linked.id);
  });

  it("filters by created_at range (inclusive bounds)", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);
    const lead = await repository.create(sampleLeadInput());

    // Bounds a second wide on either side of the real timestamp — never the razor-exact stored
    // value itself, which PostgreSQL persists with microsecond precision while `lead.createdAt`
    // (a JS `Date`) only round-trips milliseconds; comparing against the untouched value could
    // spuriously exclude it once truncated.
    const inRange = await repository.list(
      listInput({
        filters: {
          createdFrom: new Date(lead.createdAt.getTime() - 1000),
          createdTo: new Date(lead.createdAt.getTime() + 1000),
        },
      }),
    );
    const outOfRange = await repository.list(
      listInput({ filters: { createdFrom: new Date(lead.createdAt.getTime() + 60_000) } }),
    );

    expect(inRange.total).toBe(1);
    expect(outOfRange.total).toBe(0);
  });

  it("q searches case-insensitively across name/email/phone", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);
    await repository.create(sampleLeadInput({ name: "Maria Souza", email: "maria@example.com" }));
    await repository.create(sampleLeadInput({ name: "João", email: "joao@example.com", phone: "11988887777" }));

    const byName = await repository.list(listInput({ filters: { query: "MARIA" } }));
    const byPhone = await repository.list(listInput({ filters: { query: "988887777" } }));

    expect(byName.data).toHaveLength(1);
    expect(byName.data[0]?.name).toBe("Maria Souza");
    expect(byPhone.data).toHaveLength(1);
    expect(byPhone.data[0]?.phone).toBe("11988887777");
  });

  it("combines multiple filters with AND", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);
    await repository.create(sampleLeadInput({ name: "Maria Souza", source: "WEBSITE" }));
    await repository.create(sampleLeadInput({ name: "Maria Souza", source: "MANUAL" }));

    const result = await repository.list(listInput({ filters: { query: "Maria", source: "WEBSITE" } }));

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.source).toBe("WEBSITE");
  });

  it("sorts by name ascending and descending", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);
    await repository.create(sampleLeadInput({ name: "Zeca" }));
    await repository.create(sampleLeadInput({ name: "Ana" }));

    const asc = await repository.list(listInput({ sort: "name", order: "asc" }));
    const desc = await repository.list(listInput({ sort: "name", order: "desc" }));

    expect(asc.data.map((lead) => lead.name)).toEqual(["Ana", "Zeca"]);
    expect(desc.data.map((lead) => lead.name)).toEqual(["Zeca", "Ana"]);
  });

  it("update changes only the given fields (partial update)", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);
    const lead = await repository.create(sampleLeadInput());

    const updated = await repository.update(lead.id, { status: "QUALIFIED" });

    expect(updated).toMatchObject({ status: "QUALIFIED", name: lead.name, email: lead.email });
  });

  it("update can clear a nullable field with null", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);
    const lead = await repository.create(sampleLeadInput({ notes: "Ligar amanhã" }));

    const updated = await repository.update(lead.id, { notes: null });

    expect(updated?.notes).toBeNull();
  });

  it("update rejects at the database level clearing the only remaining contact channel", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);
    const lead = await repository.create(sampleLeadInput({ email: "maria@example.com", phone: null }));

    await expect(repository.update(lead.id, { email: null })).rejects.toThrow();
  });

  it("update returns undefined for a missing id", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzleLeadRepository(db);

    await expect(repository.update(randomUUID(), { status: "LOST" })).resolves.toBeUndefined();
  });

  it("clearing a property's association via ON DELETE SET NULL is exercised by application-level nulling, not a real property delete (properties are never hard-deleted)", async () => {
    // Documents the FK behavior without a real DELETE FROM properties, which no code path in
    // this codebase ever performs (archiving only ever sets status = INACTIVE).
    const db = await createMigratedTenantDatabase();
    const propertyRepository = createDrizzlePropertyRepository(db);
    const leadRepository = createDrizzleLeadRepository(db);
    const property = await propertyRepository.create(samplePropertyInput());
    const lead = await leadRepository.create(sampleLeadInput({ propertyId: property.id }));

    const updated = await leadRepository.update(lead.id, { propertyId: null });

    expect(updated?.propertyId).toBeNull();
  });
});

describe("createDrizzleLeadRepository — tenant isolation", () => {
  it("a lead created in tenant A's database is invisible to tenant B's repository", async () => {
    const dbA = await createMigratedTenantDatabase();
    const dbB = await createMigratedTenantDatabase();
    const repositoryA = createDrizzleLeadRepository(dbA);
    const repositoryB = createDrizzleLeadRepository(dbB);

    const leadInA = await repositoryA.create(sampleLeadInput({ name: "Tenant A Lead" }));

    await expect(repositoryB.findById(leadInA.id)).resolves.toBeUndefined();
    const listInB = await repositoryB.list(listInput());
    expect(listInB.total).toBe(0);
    await expect(repositoryB.update(leadInA.id, { status: "CONTACTED" })).resolves.toBeUndefined();
  });

  it("a property id from tenant A cannot be used to satisfy a lookup against tenant B", async () => {
    const dbA = await createMigratedTenantDatabase();
    const dbB = await createMigratedTenantDatabase();
    const propertyRepositoryA = createDrizzlePropertyRepository(dbA);
    const propertyRepositoryB = createDrizzlePropertyRepository(dbB);

    const propertyInA = await propertyRepositoryA.create(samplePropertyInput());

    await expect(propertyRepositoryB.findById(propertyInA.id)).resolves.toBeUndefined();
  });
});
