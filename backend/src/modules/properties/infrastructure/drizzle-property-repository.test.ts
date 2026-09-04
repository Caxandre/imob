import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runTenantMigrations } from "../../../infrastructure/database/tenant/migrate.js";
import * as tenantSchema from "../../../infrastructure/database/tenant/schema.js";
import type { CreatePropertyInput, ListPropertiesInput } from "../application/property-repository.js";
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

function listInput(overrides: Partial<ListPropertiesInput> = {}): ListPropertiesInput {
  return { page: 1, limit: 20, filters: {}, sort: "created_at", order: "desc", ...overrides };
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

    const result = await repository.list(listInput());

    expect(result.total).toBe(3);
    expect(result.data.map((property) => property.id)).toEqual([third.id, second.id, first.id]);
  });

  it("paginates correctly across pages", async () => {
    const db = await createMigratedTenantDatabase();
    const repository = createDrizzlePropertyRepository(db);

    for (let i = 0; i < 5; i += 1) {
      await repository.create(sampleInput({ title: `Property ${i}` }));
    }

    const firstPage = await repository.list(listInput({ page: 1, limit: 2 }));
    const secondPage = await repository.list(listInput({ page: 2, limit: 2 }));
    const thirdPage = await repository.list(listInput({ page: 3, limit: 2 }));

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

    await expect(repository.list(listInput())).resolves.toEqual({ data: [], total: 0 });
  });

  describe("list cover (Prompt 037A)", () => {
    async function insertMedia(
      db: Awaited<ReturnType<typeof createMigratedTenantDatabase>>,
      propertyId: string,
      overrides: Partial<{
        position: number;
        isCover: boolean;
        processingStatus: "PROCESSING" | "READY" | "FAILED";
      }> = {},
    ) {
      const id = randomUUID();
      const [row] = await db
        .insert(tenantSchema.propertyMedia)
        .values({
          id,
          propertyId,
          objectKey: `tenants/x/properties/${propertyId}/${id}.jpg`,
          publicUrl: `https://public-base.example/${id}.jpg`,
          mimeType: "image/jpeg",
          sizeBytes: 12_345,
          originalFilename: "foto.jpg",
          position: overrides.position ?? 0,
          isCover: overrides.isCover ?? false,
          processingStatus: overrides.processingStatus ?? "READY",
        })
        .returning();
      if (!row) throw new Error("property_media insert returned no row");
      return row;
    }

    async function insertVariant(
      db: Awaited<ReturnType<typeof createMigratedTenantDatabase>>,
      mediaId: string,
      variant: "THUMBNAIL" | "CARD" | "DETAIL",
      overrides: Partial<{ width: number }> = {},
    ) {
      await db.insert(tenantSchema.propertyMediaVariants).values({
        propertyMediaId: mediaId,
        variant,
        objectKey: `tenants/x/properties/y/${mediaId}/${variant.toLowerCase()}-${randomUUID()}.webp`,
        publicUrl: `https://public-base.example/${mediaId}/${variant.toLowerCase()}.webp`,
        mimeType: "image/webp",
        width: overrides.width ?? 320,
        height: 213,
        sizeBytes: 12_345,
      });
    }

    it("is null when the property has no media (section 34/48)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);
      await repository.create(sampleInput());

      const result = await repository.list(listInput());

      expect(result.data[0]?.cover).toBeNull();
    });

    it("prefers the media with is_cover=true even if another has a lower position (section 36/49)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);
      const property = await repository.create(sampleInput());
      await insertMedia(db, property.id, { position: 0, isCover: false });
      const cover = await insertMedia(db, property.id, { position: 1, isCover: true });

      const result = await repository.list(listInput());

      expect(result.data[0]?.cover?.id).toBe(cover.id);
    });

    it("falls back to the lowest position when no media has is_cover=true (section 8/19/35/50)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);
      const property = await repository.create(sampleInput());
      await insertMedia(db, property.id, { position: 1, isCover: false });
      const lowest = await insertMedia(db, property.id, { position: 0, isCover: false });

      const result = await repository.list(listInput());

      expect(result.data[0]?.cover?.id).toBe(lowest.id);
    });

    // Section 51 ("fallback tie — same position, id ASC desempata") is not exercised here: two
    // property_media rows can never share the same position for the same property —
    // `property_media_property_id_position_key` (UNIQUE(property_id, position)) makes it a
    // genuine database invariant, not just an assumption. The `id ASC` tie-break in
    // `loadCoversByPropertyIds`'s ORDER BY exists purely defensively, the same documented
    // stance already taken for the identical situation in
    // `drizzle-property-media-repository.ts`'s `listByProperty` — never forced via a real test
    // that would first have to violate a real constraint to set up.

    it("returns thumbnail/card only — never detail — for a fully-processed cover (section 9/38/52)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);
      const property = await repository.create(sampleInput());
      const media = await insertMedia(db, property.id, { isCover: true });
      await insertVariant(db, media.id, "THUMBNAIL", { width: 320 });
      await insertVariant(db, media.id, "CARD", { width: 640 });
      await insertVariant(db, media.id, "DETAIL", { width: 1280 });

      const result = await repository.list(listInput());
      const cover = result.data[0]?.cover;

      expect(cover?.variants.thumbnail?.width).toBe(320);
      expect(cover?.variants.card?.width).toBe(640);
      expect(cover?.variants).not.toHaveProperty("detail");
    });

    it("returns null thumbnail/card while the cover is still PROCESSING (section 11/53)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);
      const property = await repository.create(sampleInput());
      await insertMedia(db, property.id, { isCover: true, processingStatus: "PROCESSING" });

      const result = await repository.list(listInput());
      const cover = result.data[0]?.cover;

      expect(cover?.processingStatus).toBe("PROCESSING");
      expect(cover?.variants).toEqual({ thumbnail: null, card: null });
    });

    it("returns null thumbnail/card for a legacy READY cover with zero variant rows, never throwing (section 13/54)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);
      const property = await repository.create(sampleInput());
      await insertMedia(db, property.id, { isCover: true, processingStatus: "READY" });

      const result = await repository.list(listInput());
      const cover = result.data[0]?.cover;

      expect(cover?.processingStatus).toBe("READY");
      expect(cover?.variants).toEqual({ thumbnail: null, card: null });
    });

    it("returns a partial variant set when only one variant was generated (section 55)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);
      const property = await repository.create(sampleInput());
      const media = await insertMedia(db, property.id, { isCover: true });
      await insertVariant(db, media.id, "CARD", { width: 640 });

      const result = await repository.list(listInput());
      const cover = result.data[0]?.cover;

      expect(cover?.variants.thumbnail).toBeNull();
      expect(cover?.variants.card?.width).toBe(640);
    });

    it("never associates one property's cover with another (section 56)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);
      const propertyA = await repository.create(sampleInput({ title: "A" }));
      const propertyB = await repository.create(sampleInput({ title: "B" }));
      const mediaA = await insertMedia(db, propertyA.id, { isCover: true });
      const mediaB = await insertMedia(db, propertyB.id, { isCover: true });

      const result = await repository.list(listInput());
      const byId = new Map(result.data.map((p) => [p.id, p.cover]));

      expect(byId.get(propertyA.id)?.id).toBe(mediaA.id);
      expect(byId.get(propertyB.id)?.id).toBe(mediaB.id);
    });

    it("never changes total/total_pages — cover enrichment never touches the count query (section 26/57)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);
      const property = await repository.create(sampleInput());
      await insertMedia(db, property.id, { isCover: true });
      await insertMedia(db, property.id, { position: 1 });

      const result = await repository.list(listInput());

      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });
  });

  describe("list filters", () => {
    it("filters by status", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      await repository.create(sampleInput({ title: "Draft", status: "DRAFT" }));
      const active = await repository.create(sampleInput({ title: "Active", status: "ACTIVE" }));
      await repository.create(sampleInput({ title: "Inactive", status: "INACTIVE" }));

      const result = await repository.list(listInput({ filters: { status: "ACTIVE" } }));

      expect(result.total).toBe(1);
      expect(result.data.map((p) => p.id)).toEqual([active.id]);
    });

    it("filters by property_type", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const house = await repository.create(sampleInput({ title: "Casa", propertyType: "HOUSE" }));
      await repository.create(sampleInput({ title: "Apto", propertyType: "APARTMENT" }));
      await repository.create(sampleInput({ title: "Terreno", propertyType: "LAND" }));

      const result = await repository.list(listInput({ filters: { propertyType: "HOUSE" } }));

      expect(result.total).toBe(1);
      expect(result.data.map((p) => p.id)).toEqual([house.id]);
    });

    it("filters by transaction_type", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const forSale = await repository.create(sampleInput({ title: "Venda", transactionType: "SALE" }));
      await repository.create(sampleInput({ title: "Aluguel", transactionType: "RENT" }));

      const result = await repository.list(listInput({ filters: { transactionType: "SALE" } }));

      expect(result.total).toBe(1);
      expect(result.data.map((p) => p.id)).toEqual([forSale.id]);
    });

    it("filters by city case-insensitively after trim, without matching substrings", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const saoPaulo = await repository.create(sampleInput({ title: "SP", city: "São Paulo" }));
      await repository.create(sampleInput({ title: "Campinas", city: "Campinas" }));
      await repository.create(sampleInput({ title: "SP Interior", city: "São Paulo Interior" }));

      const result = await repository.list(listInput({ filters: { city: "são paulo" } }));

      expect(result.total).toBe(1);
      expect(result.data.map((p) => p.id)).toEqual([saoPaulo.id]);
    });

    it("filters by state", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const sp = await repository.create(sampleInput({ title: "SP", state: "SP" }));
      await repository.create(sampleInput({ title: "RJ", state: "RJ" }));

      const result = await repository.list(listInput({ filters: { state: "SP" } }));

      expect(result.total).toBe(1);
      expect(result.data.map((p) => p.id)).toEqual([sp.id]);
    });

    it("filters by price range (price_min/price_max)", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      await repository.create(sampleInput({ title: "Barato", price: "300000.00" }));
      const middle = await repository.create(sampleInput({ title: "Médio", price: "450000.00" }));
      await repository.create(sampleInput({ title: "Caro", price: "700000.00" }));

      const result = await repository.list(
        listInput({ filters: { priceMin: "350000.00", priceMax: "600000.00" } }),
      );

      expect(result.total).toBe(1);
      expect(result.data.map((p) => p.id)).toEqual([middle.id]);
    });

    it("filters by bedrooms_min/bathrooms_min/parking_spaces_min, excluding NULL rows", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const qualifies = await repository.create(
        sampleInput({ title: "Qualifica", bedrooms: 3, bathrooms: 2, parkingSpaces: 2 }),
      );
      await repository.create(sampleInput({ title: "Poucos quartos", bedrooms: 1, bathrooms: 2, parkingSpaces: 2 }));
      await repository.create(
        sampleInput({ title: "Sem info", bedrooms: null, bathrooms: null, parkingSpaces: null }),
      );

      const result = await repository.list(
        listInput({ filters: { bedroomsMin: 2, bathroomsMin: 1, parkingSpacesMin: 1 } }),
      );

      expect(result.total).toBe(1);
      expect(result.data.map((p) => p.id)).toEqual([qualifies.id]);
    });

    it("filters by area range (area_min/area_max), excluding NULL rows", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const inRange = await repository.create(sampleInput({ title: "Na faixa", areaM2: "80.00" }));
      await repository.create(sampleInput({ title: "Pequeno", areaM2: "40.00" }));
      await repository.create(sampleInput({ title: "Sem área", areaM2: null }));

      const result = await repository.list(listInput({ filters: { areaMin: "60.00", areaMax: "100.00" } }));

      expect(result.total).toBe(1);
      expect(result.data.map((p) => p.id)).toEqual([inRange.id]);
    });

    it("combines multiple filters with AND semantics", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const match = await repository.create(
        sampleInput({
          title: "Combina",
          status: "ACTIVE",
          propertyType: "APARTMENT",
          city: "São Paulo",
          price: "500000.00",
        }),
      );
      // Fails city.
      await repository.create(
        sampleInput({ title: "Cidade errada", status: "ACTIVE", propertyType: "APARTMENT", city: "Campinas" }),
      );
      // Fails status.
      await repository.create(
        sampleInput({ title: "Status errado", status: "DRAFT", propertyType: "APARTMENT", city: "São Paulo" }),
      );
      // Fails price_max.
      await repository.create(
        sampleInput({
          title: "Muito caro",
          status: "ACTIVE",
          propertyType: "APARTMENT",
          city: "São Paulo",
          price: "900000.00",
        }),
      );

      const result = await repository.list(
        listInput({
          filters: { status: "ACTIVE", propertyType: "APARTMENT", city: "São Paulo", priceMax: "600000.00" },
        }),
      );

      expect(result.total).toBe(1);
      expect(result.data.map((p) => p.id)).toEqual([match.id]);
    });

    it("reports the filtered total, not the tenant's overall count", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      for (let i = 0; i < 7; i += 1) {
        await repository.create(sampleInput({ title: `Outro ${i}`, status: "DRAFT" }));
      }
      for (let i = 0; i < 3; i += 1) {
        await repository.create(sampleInput({ title: `Ativo ${i}`, status: "ACTIVE" }));
      }

      const result = await repository.list(listInput({ filters: { status: "ACTIVE" } }));

      expect(result.total).toBe(3);
    });

    it("paginates a filtered result set correctly", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      for (let i = 0; i < 5; i += 1) {
        await repository.create(sampleInput({ title: `Ativo ${i}`, status: "ACTIVE" }));
      }
      await repository.create(sampleInput({ title: "Draft", status: "DRAFT" }));

      const firstPage = await repository.list(listInput({ page: 1, limit: 2, filters: { status: "ACTIVE" } }));
      const secondPage = await repository.list(listInput({ page: 2, limit: 2, filters: { status: "ACTIVE" } }));
      const thirdPage = await repository.list(listInput({ page: 3, limit: 2, filters: { status: "ACTIVE" } }));

      expect(firstPage.data).toHaveLength(2);
      expect(secondPage.data).toHaveLength(2);
      expect(thirdPage.data).toHaveLength(1);
      expect(firstPage.total).toBe(5);
      expect(secondPage.total).toBe(5);
      expect(thirdPage.total).toBe(5);
    });
  });

  describe("list sorting", () => {
    it("sorts by price ascending", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const low = await repository.create(sampleInput({ title: "Baixo", price: "100000.00" }));
      const mid = await repository.create(sampleInput({ title: "Médio", price: "300000.00" }));
      const high = await repository.create(sampleInput({ title: "Alto", price: "700000.00" }));

      const result = await repository.list(listInput({ sort: "price", order: "asc" }));

      expect(result.data.map((p) => p.id)).toEqual([low.id, mid.id, high.id]);
    });

    it("sorts by price descending", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const low = await repository.create(sampleInput({ title: "Baixo", price: "100000.00" }));
      const mid = await repository.create(sampleInput({ title: "Médio", price: "300000.00" }));
      const high = await repository.create(sampleInput({ title: "Alto", price: "700000.00" }));

      const result = await repository.list(listInput({ sort: "price", order: "desc" }));

      expect(result.data.map((p) => p.id)).toEqual([high.id, mid.id, low.id]);
    });

    it("sorts a nullable column with NULLS LAST in both directions", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const withArea = await repository.create(sampleInput({ title: "Com área", areaM2: "80.00" }));
      const withoutArea = await repository.create(sampleInput({ title: "Sem área", areaM2: null }));

      const ascending = await repository.list(listInput({ sort: "area_m2", order: "asc" }));
      const descending = await repository.list(listInput({ sort: "area_m2", order: "desc" }));

      expect(ascending.data.map((p) => p.id)).toEqual([withArea.id, withoutArea.id]);
      expect(descending.data.map((p) => p.id)).toEqual([withArea.id, withoutArea.id]);
    });

    it("breaks ties deterministically by id when the sort column has equal values", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const first = await repository.create(sampleInput({ title: "Empate 1", price: "500000.00" }));
      const second = await repository.create(sampleInput({ title: "Empate 2", price: "500000.00" }));
      const third = await repository.create(sampleInput({ title: "Empate 3", price: "500000.00" }));

      const expectedAsc = [first, second, third].map((p) => p.id).sort();
      const expectedDesc = [...expectedAsc].reverse();

      const ascending = await repository.list(listInput({ sort: "price", order: "asc" }));
      const descending = await repository.list(listInput({ sort: "price", order: "desc" }));

      expect(ascending.data.map((p) => p.id)).toEqual(expectedAsc);
      expect(descending.data.map((p) => p.id)).toEqual(expectedDesc);
    });
  });

  describe("full-text search (q)", () => {
    it("finds a property by a term in title", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const match = await repository.create(sampleInput({ title: "Apartamento no Centro" }));
      await repository.create(sampleInput({ title: "Casa na Praia" }));

      const result = await repository.list(listInput({ filters: { query: "apartamento" }, sort: "relevance" }));

      expect(result.data.map((p) => p.id)).toEqual([match.id]);
      expect(result.total).toBe(1);
    });

    it("finds a property by a term that only occurs in description", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const match = await repository.create(
        sampleInput({ title: "Imóvel disponível", description: "Reformado recentemente, vista panorâmica" }),
      );
      await repository.create(sampleInput({ title: "Outro imóvel", description: "Sem reforma" }));

      const result = await repository.list(listInput({ filters: { query: "panorâmica" }, sort: "relevance" }));

      expect(result.data.map((p) => p.id)).toEqual([match.id]);
    });

    it("finds a property by a term in neighborhood", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const match = await repository.create(sampleInput({ title: "Cobertura", neighborhood: "Moema" }));
      await repository.create(sampleInput({ title: "Outra cobertura", neighborhood: "Pinheiros" }));

      const result = await repository.list(listInput({ filters: { query: "moema" }, sort: "relevance" }));

      expect(result.data.map((p) => p.id)).toEqual([match.id]);
    });

    it("ranks a match in title above the same term occurring only in description", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      // neighborhood/city overridden to null on both — sampleInput()'s own default
      // neighborhood is "Centro", which would otherwise contribute an equal weight-B match to
      // both properties and muddy this specific title-vs-description comparison.
      const titleMatch = await repository.create(
        sampleInput({
          title: "Apartamento no Centro",
          description: "Excelente custo-benefício",
          neighborhood: null,
          city: null,
        }),
      );
      const descriptionMatch = await repository.create(
        sampleInput({
          title: "Apartamento residencial",
          description: "Próximo ao centro comercial",
          neighborhood: null,
          city: null,
        }),
      );

      const result = await repository.list(listInput({ filters: { query: "centro" }, sort: "relevance" }));

      expect(result.data.map((p) => p.id)).toEqual([titleMatch.id, descriptionMatch.id]);
    });

    it("combines q with structured filters using AND", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const match = await repository.create(
        sampleInput({ title: "Apartamento no Centro", status: "ACTIVE", transactionType: "SALE" }),
      );
      // Same text, wrong status.
      await repository.create(
        sampleInput({ title: "Apartamento no Centro", status: "DRAFT", transactionType: "SALE" }),
      );
      // Same text, wrong transaction type.
      await repository.create(
        sampleInput({ title: "Apartamento no Centro", status: "ACTIVE", transactionType: "RENT" }),
      );

      const result = await repository.list(
        listInput({
          filters: { query: "apartamento centro", status: "ACTIVE", transactionType: "SALE" },
          sort: "relevance",
        }),
      );

      expect(result.data.map((p) => p.id)).toEqual([match.id]);
      expect(result.total).toBe(1);
    });

    it("reports the q-filtered total and paginates correctly", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      for (let i = 0; i < 5; i += 1) {
        await repository.create(sampleInput({ title: `Apartamento ${i} no Centro` }));
      }
      await repository.create(sampleInput({ title: "Casa na Praia" }));

      const firstPage = await repository.list(
        listInput({ page: 1, limit: 2, filters: { query: "apartamento" }, sort: "relevance" }),
      );
      const secondPage = await repository.list(
        listInput({ page: 2, limit: 2, filters: { query: "apartamento" }, sort: "relevance" }),
      );

      expect(firstPage.data).toHaveLength(2);
      expect(secondPage.data).toHaveLength(2);
      expect(firstPage.total).toBe(5);
      expect(secondPage.total).toBe(5);
    });

    it("respects an explicit sort over q, ordering by the requested column instead of relevance", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      const cheap = await repository.create(sampleInput({ title: "Apartamento Centro", price: "200000.00" }));
      const expensive = await repository.create(sampleInput({ title: "Apartamento Centro", price: "900000.00" }));

      const result = await repository.list(
        listInput({ filters: { query: "apartamento" }, sort: "price", order: "asc" }),
      );

      expect(result.data.map((p) => p.id)).toEqual([cheap.id, expensive.id]);
    });

    it("proves the generated search_vector updates automatically on title change", async () => {
      const db = await createMigratedTenantDatabase();
      const repository = createDrizzlePropertyRepository(db);

      // neighborhood/city overridden to null — sampleInput()'s own default neighborhood is
      // "Centro", which would otherwise keep matching "centro" after the title change below and
      // defeat the point of this test.
      const created = await repository.create(
        sampleInput({ title: "Apartamento no Centro", neighborhood: null, city: null }),
      );

      const beforeUpdate = await repository.list(listInput({ filters: { query: "centro" }, sort: "relevance" }));
      expect(beforeUpdate.data.map((p) => p.id)).toContain(created.id);

      await repository.update(created.id, { title: "Casa nos Jardins" });

      const afterUpdateOldTerm = await repository.list(
        listInput({ filters: { query: "centro" }, sort: "relevance" }),
      );
      const afterUpdateNewTerm = await repository.list(
        listInput({ filters: { query: "jardins" }, sort: "relevance" }),
      );

      expect(afterUpdateOldTerm.data.map((p) => p.id)).not.toContain(created.id);
      expect(afterUpdateNewTerm.data.map((p) => p.id)).toContain(created.id);
    });
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
