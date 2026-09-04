import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, escapeIdentifier } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runTenantMigrations } from "../../../infrastructure/database/tenant/migrate.js";
import * as tenantSchema from "../../../infrastructure/database/tenant/schema.js";
import type { CreatePropertyMediaInput } from "../application/property-media-repository.js";
import type { CreatePropertyInput } from "../application/property-repository.js";
import { PropertyMediaNotFoundError, PropertyMediaReorderMismatchError } from "../domain/property-media.js";
import { createDrizzlePropertyMediaRepository } from "./drizzle-property-media-repository.js";
import { createDrizzlePropertyRepository } from "./drizzle-property-repository.js";

/** Real `postgres-tenants` (Docker Compose), never mocked — same convention as
 * `drizzle-property-repository.test.ts`. */
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
  const databaseName = `property_media_repo_test_${randomUUID().replaceAll("-", "")}`;
  await withAdminClient((client) => client.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`));

  await runTenantMigrations({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  const pool = new Pool({ host: HOST, port: PORT, database: databaseName, user: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  createdFixtures.push({ databaseName, pool });

  return drizzle(pool, { schema: tenantSchema });
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

function sampleMediaInput(
  propertyId: string,
  overrides: Partial<CreatePropertyMediaInput> = {},
): CreatePropertyMediaInput {
  const id = randomUUID();
  return {
    id,
    propertyId,
    objectKey: `tenants/test-tenant/properties/${propertyId}/${id}.jpg`,
    publicUrl: `https://public-base.example/tenants/test-tenant/properties/${propertyId}/${id}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 12345,
    originalFilename: "foto.jpg",
    ...overrides,
  };
}

describe("createDrizzlePropertyMediaRepository", () => {
  describe("create", () => {
    it("creates the first media at position 0", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      const media = await mediaRepository.create(sampleMediaInput(property.id));

      expect(media.position).toBe(0);
      expect(media.propertyId).toBe(property.id);
      expect(media.createdAt).toBeInstanceOf(Date);
      expect(media.updatedAt).toBeInstanceOf(Date);
    });

    it("the first media for a property automatically becomes its cover; later ones do not", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      const first = await mediaRepository.create(sampleMediaInput(property.id));
      const second = await mediaRepository.create(sampleMediaInput(property.id));

      expect(first.isCover).toBe(true);
      expect(second.isCover).toBe(false);
    });

    it("assigns sequential positions for successive uploads to the same property", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      const first = await mediaRepository.create(sampleMediaInput(property.id));
      const second = await mediaRepository.create(sampleMediaInput(property.id));
      const third = await mediaRepository.create(sampleMediaInput(property.id));

      expect([first.position, second.position, third.position]).toEqual([0, 1, 2]);
    });

    it("assigns positions independently per property", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const propertyA = await propertyRepository.create(samplePropertyInput({ title: "A" }));
      const propertyB = await propertyRepository.create(samplePropertyInput({ title: "B" }));

      await mediaRepository.create(sampleMediaInput(propertyA.id));
      const firstForB = await mediaRepository.create(sampleMediaInput(propertyB.id));

      expect(firstForB.position).toBe(0);
      // Each property's own first upload becomes its own cover, independently.
      expect(firstForB.isCover).toBe(true);
    });

    it("assigns strictly increasing, unique positions under real concurrent uploads to the same property, with exactly one cover", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      const results = await Promise.all(
        Array.from({ length: 8 }, () => mediaRepository.create(sampleMediaInput(property.id))),
      );

      const positions = results.map((media) => media.position).sort((a, b) => a - b);
      expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      // The partial unique index (`property_media_one_cover_per_property`) guarantees this even
      // under real concurrency — the row lock on the property serializes the decision.
      expect(results.filter((media) => media.isCover)).toHaveLength(1);
    });

    it("new media is always inserted as PROCESSING (Prompt 030, section 5)", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      const media = await mediaRepository.create(sampleMediaInput(property.id));

      expect(media.processingStatus).toBe("PROCESSING");
    });

    it("inserts a PROPERTY_MEDIA_PROCESSING_REQUESTED outbox event atomically with the media row (Prompt 030, section 40/45)", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      const media = await mediaRepository.create(sampleMediaInput(property.id));

      const events = await db
        .select()
        .from(tenantSchema.outboxEvents)
        .where(eq(tenantSchema.outboxEvents.aggregateId, media.id));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateType: "PROPERTY_MEDIA",
        aggregateId: media.id,
        eventType: "PROPERTY_MEDIA_PROCESSING_REQUESTED",
        payload: { propertyId: property.id, mediaId: media.id },
        processedAt: null,
      });
      expect(events[0]?.occurredAt).toBeInstanceOf(Date);
    });

    it("each upload produces exactly one outbox event — never one per property, never duplicated", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      const first = await mediaRepository.create(sampleMediaInput(property.id));
      const second = await mediaRepository.create(sampleMediaInput(property.id));

      const events = await db
        .select()
        .from(tenantSchema.outboxEvents)
        .where(eq(tenantSchema.outboxEvents.aggregateType, "PROPERTY_MEDIA"));

      expect(events).toHaveLength(2);
      expect(events.map((event) => event.aggregateId).sort()).toEqual([first.id, second.id].sort());
    });
  });

  describe("listByProperty", () => {
    it("returns an empty array when the property has no media", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      await expect(mediaRepository.listByProperty(property.id)).resolves.toEqual([]);
    });

    it("orders by position ASC", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      const first = await mediaRepository.create(sampleMediaInput(property.id));
      const second = await mediaRepository.create(sampleMediaInput(property.id));
      const third = await mediaRepository.create(sampleMediaInput(property.id));

      const list = await mediaRepository.listByProperty(property.id);

      expect(list.map((media) => media.id)).toEqual([first.id, second.id, third.id]);
    });

    it("only returns media for the requested property", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const propertyA = await propertyRepository.create(samplePropertyInput({ title: "A" }));
      const propertyB = await propertyRepository.create(samplePropertyInput({ title: "B" }));

      const mediaA = await mediaRepository.create(sampleMediaInput(propertyA.id));
      await mediaRepository.create(sampleMediaInput(propertyB.id));

      const list = await mediaRepository.listByProperty(propertyA.id);

      expect(list.map((media) => media.id)).toEqual([mediaA.id]);
    });

    it("returns full metadata including originalFilename/mimeType/sizeBytes/publicUrl", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      await mediaRepository.create(
        sampleMediaInput(property.id, {
          mimeType: "image/png",
          sizeBytes: 999,
          originalFilename: "sala.png",
          publicUrl: "https://public-base.example/tenants/x/properties/y/z.png",
        }),
      );

      const [media] = await mediaRepository.listByProperty(property.id);

      expect(media).toMatchObject({
        mimeType: "image/png",
        sizeBytes: 999,
        originalFilename: "sala.png",
        publicUrl: "https://public-base.example/tenants/x/properties/y/z.png",
      });
    });
  });

  describe("variants (Prompt 035)", () => {
    function sampleVariantInput(
      propertyMediaId: string,
      overrides: Partial<typeof tenantSchema.propertyMediaVariants.$inferInsert> = {},
    ) {
      const suffix = randomUUID();
      return {
        propertyMediaId,
        variant: "THUMBNAIL" as const,
        objectKey: `tenants/test-tenant/properties/prop/${propertyMediaId}/${suffix}.webp`,
        publicUrl: `https://public-base.example/${suffix}.webp`,
        mimeType: "image/webp",
        width: 320,
        height: 213,
        sizeBytes: 12_345,
        ...overrides,
      };
    }

    it("create() returns an empty variant set without querying property_media_variants", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      const media = await mediaRepository.create(sampleMediaInput(property.id));

      expect(media.variants).toEqual({ thumbnail: null, card: null, detail: null });
    });

    it("listByProperty groups a fully-processed media's three variants by fixed key", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const media = await mediaRepository.create(sampleMediaInput(property.id));
      await db.insert(tenantSchema.propertyMediaVariants).values([
        sampleVariantInput(media.id, { variant: "THUMBNAIL", width: 320 }),
        sampleVariantInput(media.id, { variant: "CARD", width: 640 }),
        sampleVariantInput(media.id, { variant: "DETAIL", width: 1280 }),
      ]);

      const [listed] = await mediaRepository.listByProperty(property.id);

      expect(listed?.variants.thumbnail?.width).toBe(320);
      expect(listed?.variants.card?.width).toBe(640);
      expect(listed?.variants.detail?.width).toBe(1280);
    });

    it("listByProperty returns an empty variant set for media with zero variant rows — never throws", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      await mediaRepository.create(sampleMediaInput(property.id));

      const [listed] = await mediaRepository.listByProperty(property.id);

      expect(listed?.variants).toEqual({ thumbnail: null, card: null, detail: null });
    });

    it("never associates one media's variants with another — grouping is keyed by property_media_id, not row order", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const mediaA = await mediaRepository.create(sampleMediaInput(property.id));
      const mediaB = await mediaRepository.create(sampleMediaInput(property.id));
      // Inserted in an order that would trip up a naive "assume row order matches media order"
      // grouping strategy — B's variant first, A's second.
      await db.insert(tenantSchema.propertyMediaVariants).values([
        sampleVariantInput(mediaB.id, { variant: "CARD", width: 999 }),
        sampleVariantInput(mediaA.id, { variant: "THUMBNAIL", width: 111 }),
      ]);

      const list = await mediaRepository.listByProperty(property.id);
      const byId = new Map(list.map((media) => [media.id, media.variants]));

      expect(byId.get(mediaA.id)?.thumbnail?.width).toBe(111);
      expect(byId.get(mediaA.id)?.card).toBeNull();
      expect(byId.get(mediaB.id)?.card?.width).toBe(999);
      expect(byId.get(mediaB.id)?.thumbnail).toBeNull();
    });

    it("never exposes id/propertyMediaId/objectKey/createdAt/updatedAt on the mapped variant DTO fields the HTTP layer reads", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const media = await mediaRepository.create(sampleMediaInput(property.id));
      await db.insert(tenantSchema.propertyMediaVariants).values(sampleVariantInput(media.id));

      const [listed] = await mediaRepository.listByProperty(property.id);
      const thumbnail = listed?.variants.thumbnail;

      // The domain object itself still carries these (internal use, e.g. delete) — this
      // confirms the fields the HTTP mapper (`toVariantResponse`) actually reads are exactly
      // the public five, never assuming the repository already stripped anything.
      expect(thumbnail).toMatchObject({ mimeType: "image/webp", width: 320, height: 213, sizeBytes: 12_345 });
      expect(typeof thumbnail?.publicUrl).toBe("string");
    });

    it("setCover carries the media's existing variants forward unchanged", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const media = await mediaRepository.create(sampleMediaInput(property.id));
      await db.insert(tenantSchema.propertyMediaVariants).values(sampleVariantInput(media.id, { variant: "THUMBNAIL", width: 320 }));

      const updated = await mediaRepository.setCover(property.id, media.id);

      expect(updated.variants.thumbnail?.width).toBe(320);
    });

    it("reorder carries every media's existing variants forward unchanged", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const first = await mediaRepository.create(sampleMediaInput(property.id));
      const second = await mediaRepository.create(sampleMediaInput(property.id));
      await db.insert(tenantSchema.propertyMediaVariants).values(sampleVariantInput(first.id, { variant: "CARD", width: 640 }));

      const reordered = await mediaRepository.reorder(property.id, [second.id, first.id]);

      const byId = new Map(reordered.map((media) => [media.id, media.variants]));
      expect(byId.get(first.id)?.card?.width).toBe(640);
      expect(byId.get(second.id)?.card).toBeNull();
    });
  });

  describe("reorder", () => {
    it("reassigns positions to match the submitted order, leaving isCover untouched", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const a = await mediaRepository.create(sampleMediaInput(property.id));
      const b = await mediaRepository.create(sampleMediaInput(property.id));
      const c = await mediaRepository.create(sampleMediaInput(property.id));
      expect(a.isCover).toBe(true); // sanity check on the fixture before reordering

      const result = await mediaRepository.reorder(property.id, [c.id, a.id, b.id]);

      expect(result.map((media) => ({ id: media.id, position: media.position }))).toEqual([
        { id: c.id, position: 0 },
        { id: a.id, position: 1 },
        { id: b.id, position: 2 },
      ]);
      // Cover is independent of position (this task, section 23) — `a` is still the cover even
      // though it moved from position 0 to 1.
      const aAfter = result.find((media) => media.id === a.id);
      expect(aAfter?.isCover).toBe(true);
    });

    it("accepts an empty list as a no-op when the property has no media", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());

      await expect(mediaRepository.reorder(property.id, [])).resolves.toEqual([]);
    });

    it("rejects (PropertyMediaReorderMismatchError) an empty list when the property has media", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      await mediaRepository.create(sampleMediaInput(property.id));

      await expect(mediaRepository.reorder(property.id, [])).rejects.toBeInstanceOf(
        PropertyMediaReorderMismatchError,
      );
    });

    it("rejects (PropertyMediaReorderMismatchError) a list missing some of the current media", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const a = await mediaRepository.create(sampleMediaInput(property.id));
      await mediaRepository.create(sampleMediaInput(property.id));

      await expect(mediaRepository.reorder(property.id, [a.id])).rejects.toBeInstanceOf(
        PropertyMediaReorderMismatchError,
      );
    });

    it("rejects (PropertyMediaNotFoundError) a media id that does not belong to the property", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const propertyA = await propertyRepository.create(samplePropertyInput({ title: "A" }));
      const propertyB = await propertyRepository.create(samplePropertyInput({ title: "B" }));
      const a = await mediaRepository.create(sampleMediaInput(propertyA.id));
      const foreign = await mediaRepository.create(sampleMediaInput(propertyB.id));

      await expect(mediaRepository.reorder(propertyA.id, [foreign.id])).rejects.toBeInstanceOf(
        PropertyMediaNotFoundError,
      );
      // `a` (the real member of propertyA) was never even mentioned, but the foreign id alone
      // is enough to fail with 404-mapped error before any mismatch check.
      void a;
    });

    it("never leaves the gallery with duplicate or gapped positions after reordering (0..N-1 invariant)", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const ids = [] as string[];
      for (let i = 0; i < 4; i += 1) {
        ids.push((await mediaRepository.create(sampleMediaInput(property.id))).id);
      }

      const reversed = [...ids].reverse();
      const result = await mediaRepository.reorder(property.id, reversed);

      expect(result.map((media) => media.position)).toEqual([0, 1, 2, 3]);
      expect(result.map((media) => media.id)).toEqual(reversed);
    });
  });

  describe("setCover", () => {
    it("sets the selected media as cover and unsets the previous one", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const a = await mediaRepository.create(sampleMediaInput(property.id));
      const b = await mediaRepository.create(sampleMediaInput(property.id));
      expect(a.isCover).toBe(true);
      expect(b.isCover).toBe(false);

      const updated = await mediaRepository.setCover(property.id, b.id);

      expect(updated.id).toBe(b.id);
      expect(updated.isCover).toBe(true);
      const list = await mediaRepository.listByProperty(property.id);
      expect(list.find((media) => media.id === a.id)?.isCover).toBe(false);
      expect(list.find((media) => media.id === b.id)?.isCover).toBe(true);
      expect(list.filter((media) => media.isCover)).toHaveLength(1);
    });

    it("is idempotent — selecting the already-current cover still succeeds", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const a = await mediaRepository.create(sampleMediaInput(property.id));

      const first = await mediaRepository.setCover(property.id, a.id);
      const second = await mediaRepository.setCover(property.id, a.id);

      expect(first.isCover).toBe(true);
      expect(second.isCover).toBe(true);
      const list = await mediaRepository.listByProperty(property.id);
      expect(list.filter((media) => media.isCover)).toHaveLength(1);
    });

    it("rejects (PropertyMediaNotFoundError) a media id from a different property", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const propertyA = await propertyRepository.create(samplePropertyInput({ title: "A" }));
      const propertyB = await propertyRepository.create(samplePropertyInput({ title: "B" }));
      const foreign = await mediaRepository.create(sampleMediaInput(propertyB.id));

      await expect(mediaRepository.setCover(propertyA.id, foreign.id)).rejects.toBeInstanceOf(
        PropertyMediaNotFoundError,
      );
    });

    it("never results in more than one cover under real concurrent cover-setting requests", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const a = await mediaRepository.create(sampleMediaInput(property.id));
      const b = await mediaRepository.create(sampleMediaInput(property.id));

      // Two concurrent requests selecting *different* media as cover — this task, section 55:
      // whichever wins is not asserted (the lock only guarantees serialization, not which
      // caller's transaction commits first), only that exactly one cover survives.
      await Promise.allSettled([
        mediaRepository.setCover(property.id, a.id),
        mediaRepository.setCover(property.id, b.id),
      ]);

      const list = await mediaRepository.listByProperty(property.id);
      expect(list.filter((media) => media.isCover)).toHaveLength(1);
    });
  });

  describe("delete", () => {
    it("removes the media and reindexes remaining positions to 0..N-1", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const a = await mediaRepository.create(sampleMediaInput(property.id));
      const b = await mediaRepository.create(sampleMediaInput(property.id));
      const c = await mediaRepository.create(sampleMediaInput(property.id));

      const result = await mediaRepository.delete(property.id, b.id);

      expect(result.objectKey).toBe(b.objectKey);
      expect(result.variantObjectKeys).toEqual([]);
      const list = await mediaRepository.listByProperty(property.id);
      expect(list.map((media) => ({ id: media.id, position: media.position }))).toEqual([
        { id: a.id, position: 0 },
        { id: c.id, position: 1 },
      ]);
    });

    it("returns every variant's object_key (read before the cascade removes the rows) and the variants are actually gone afterward", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const media = await mediaRepository.create(sampleMediaInput(property.id));
      const variantInputs = [
        { variant: "THUMBNAIL" as const, objectKey: `tenants/t/properties/p/${media.id}/thumbnail.webp` },
        { variant: "CARD" as const, objectKey: `tenants/t/properties/p/${media.id}/card.webp` },
        { variant: "DETAIL" as const, objectKey: `tenants/t/properties/p/${media.id}/detail.webp` },
      ];
      for (const input of variantInputs) {
        await db.insert(tenantSchema.propertyMediaVariants).values({
          propertyMediaId: media.id,
          variant: input.variant,
          objectKey: input.objectKey,
          publicUrl: `https://public-base.example/${input.objectKey}`,
          mimeType: "image/webp",
          width: 320,
          height: 240,
          sizeBytes: 4096,
        });
      }

      const result = await mediaRepository.delete(property.id, media.id);

      expect(result.objectKey).toBe(media.objectKey);
      expect(result.variantObjectKeys.sort()).toEqual(variantInputs.map((v) => v.objectKey).sort());

      const remainingVariants = await db
        .select()
        .from(tenantSchema.propertyMediaVariants)
        .where(eq(tenantSchema.propertyMediaVariants.propertyMediaId, media.id));
      expect(remainingVariants).toHaveLength(0);
    });

    it("promotes the media now at position 0 to cover when the deleted media was the cover", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const a = await mediaRepository.create(sampleMediaInput(property.id));
      const b = await mediaRepository.create(sampleMediaInput(property.id));
      expect(a.isCover).toBe(true);

      await mediaRepository.delete(property.id, a.id);

      const list = await mediaRepository.listByProperty(property.id);
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(b.id);
      expect(list[0]?.isCover).toBe(true);
      expect(list[0]?.position).toBe(0);
    });

    it("leaves the gallery with no cover when the only media (the cover) is deleted", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const a = await mediaRepository.create(sampleMediaInput(property.id));
      expect(a.isCover).toBe(true);

      await mediaRepository.delete(property.id, a.id);

      await expect(mediaRepository.listByProperty(property.id)).resolves.toEqual([]);
    });

    it("leaves the current cover unchanged when a non-cover media is deleted", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const property = await propertyRepository.create(samplePropertyInput());
      const a = await mediaRepository.create(sampleMediaInput(property.id));
      const b = await mediaRepository.create(sampleMediaInput(property.id));
      expect(a.isCover).toBe(true);

      await mediaRepository.delete(property.id, b.id);

      const list = await mediaRepository.listByProperty(property.id);
      expect(list.find((media) => media.id === a.id)?.isCover).toBe(true);
    });

    it("rejects (PropertyMediaNotFoundError) a media id from a different property, changing nothing", async () => {
      const db = await createMigratedTenantDatabase();
      const propertyRepository = createDrizzlePropertyRepository(db);
      const mediaRepository = createDrizzlePropertyMediaRepository(db);
      const propertyA = await propertyRepository.create(samplePropertyInput({ title: "A" }));
      const propertyB = await propertyRepository.create(samplePropertyInput({ title: "B" }));
      const foreign = await mediaRepository.create(sampleMediaInput(propertyB.id));

      await expect(mediaRepository.delete(propertyA.id, foreign.id)).rejects.toBeInstanceOf(
        PropertyMediaNotFoundError,
      );
      await expect(mediaRepository.listByProperty(propertyB.id)).resolves.toHaveLength(1);
    });
  });
});

/**
 * `property_media_variants` has no repository yet (Prompt 030, section 57 — deliberately: no
 * consumer exists to write to it until the future processing worker does). These tests insert
 * directly through the Drizzle table object to prove the schema itself (constraints, cascade,
 * isolation) — the same level the migration operates at — without inventing CRUD code nothing
 * calls.
 */
describe("property_media_variants schema (Prompt 030)", () => {
  function sampleVariantInput(
    propertyMediaId: string,
    overrides: Partial<typeof tenantSchema.propertyMediaVariants.$inferInsert> = {},
  ) {
    const suffix = randomUUID();
    return {
      propertyMediaId,
      variant: "THUMBNAIL" as const,
      objectKey: `tenants/test-tenant/properties/prop/${propertyMediaId}/thumbnail-${suffix}.webp`,
      publicUrl: `https://public-base.example/${suffix}.webp`,
      mimeType: "image/webp",
      width: 320,
      height: 200,
      sizeBytes: 4096,
      ...overrides,
    };
  }

  it("inserts a variant row referencing a real property_media id", async () => {
    const db = await createMigratedTenantDatabase();
    const propertyRepository = createDrizzlePropertyRepository(db);
    const mediaRepository = createDrizzlePropertyMediaRepository(db);
    const property = await propertyRepository.create(samplePropertyInput());
    const media = await mediaRepository.create(sampleMediaInput(property.id));

    const [inserted] = await db
      .insert(tenantSchema.propertyMediaVariants)
      .values(sampleVariantInput(media.id))
      .returning();

    expect(inserted?.variant).toBe("THUMBNAIL");
    expect(inserted?.propertyMediaId).toBe(media.id);
  });

  it("rejects a second row for the same (property_media_id, variant) — UNIQUE(property_media_id, variant)", async () => {
    const db = await createMigratedTenantDatabase();
    const propertyRepository = createDrizzlePropertyRepository(db);
    const mediaRepository = createDrizzlePropertyMediaRepository(db);
    const property = await propertyRepository.create(samplePropertyInput());
    const media = await mediaRepository.create(sampleMediaInput(property.id));
    await db.insert(tenantSchema.propertyMediaVariants).values(sampleVariantInput(media.id));

    await expect(db.insert(tenantSchema.propertyMediaVariants).values(sampleVariantInput(media.id))).rejects.toThrow();
  });

  it("cascades on delete when the parent property_media row is removed (ON DELETE CASCADE)", async () => {
    const db = await createMigratedTenantDatabase();
    const propertyRepository = createDrizzlePropertyRepository(db);
    const mediaRepository = createDrizzlePropertyMediaRepository(db);
    const property = await propertyRepository.create(samplePropertyInput());
    const media = await mediaRepository.create(sampleMediaInput(property.id));
    await db.insert(tenantSchema.propertyMediaVariants).values(sampleVariantInput(media.id));

    // Prompt 028's real delete path — a genuine, physical DELETE of the property_media row,
    // exercising the FK's cascade for real rather than a raw DELETE this test invents itself.
    await mediaRepository.delete(property.id, media.id);

    const remaining = await db
      .select()
      .from(tenantSchema.propertyMediaVariants)
      .where(eq(tenantSchema.propertyMediaVariants.propertyMediaId, media.id));
    expect(remaining).toHaveLength(0);
  });

  it.each([
    ["width", { width: 0 }],
    ["height", { height: 0 }],
    ["size_bytes", { sizeBytes: 0 }],
  ] as const)("rejects a non-positive %s — CHECK constraint", async (_label, overrides) => {
    const db = await createMigratedTenantDatabase();
    const propertyRepository = createDrizzlePropertyRepository(db);
    const mediaRepository = createDrizzlePropertyMediaRepository(db);
    const property = await propertyRepository.create(samplePropertyInput());
    const media = await mediaRepository.create(sampleMediaInput(property.id));

    await expect(
      db.insert(tenantSchema.propertyMediaVariants).values(sampleVariantInput(media.id, overrides)),
    ).rejects.toThrow();
  });

  it("has no tenant_id column (ADR-001) — isolation stays the physical database boundary", async () => {
    const db = await createMigratedTenantDatabase();

    const result = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'property_media_variants'
    `);
    const columnNames = result.rows.map((row) => (row as { column_name: string }).column_name);

    expect(columnNames).not.toContain("tenant_id");
  });
});
