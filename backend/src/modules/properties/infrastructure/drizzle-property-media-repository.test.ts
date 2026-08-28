import { randomUUID } from "node:crypto";

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
      const list = await mediaRepository.listByProperty(property.id);
      expect(list.map((media) => ({ id: media.id, position: media.position }))).toEqual([
        { id: a.id, position: 0 },
        { id: c.id, position: 1 },
      ]);
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
