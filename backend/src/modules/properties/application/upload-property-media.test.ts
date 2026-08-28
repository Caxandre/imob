import { describe, expect, it } from "vitest";

import type { ObjectStorage, PutObjectInput, StoredObject } from "../../../infrastructure/object-storage/object-storage.js";
import type { PropertyMedia } from "../domain/property-media.js";
import { PropertyArchivedError, PropertyNotFoundError, type Property } from "../domain/property.js";
import type { PropertyMediaRepository } from "./property-media-repository.js";
import type { PropertyRepository } from "./property-repository.js";
import { buildPropertyMediaObjectKey, PropertyMediaPersistError, uploadPropertyMedia } from "./upload-property-media.js";

const FAKE_PROPERTY: Property = {
  id: "11111111-1111-4111-8111-111111111111",
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
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const FAKE_MEDIA: PropertyMedia = {
  id: "22222222-2222-4222-8222-222222222222",
  propertyId: FAKE_PROPERTY.id,
  objectKey: "tenants/tenant-1/properties/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg",
  publicUrl: "https://public-base.example/some-key.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 5,
  originalFilename: "foto.jpg",
  position: 0,
  isCover: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function fakePropertyRepository(overrides: Partial<PropertyRepository> = {}): PropertyRepository {
  return {
    create: async () => FAKE_PROPERTY,
    list: async () => ({ data: [], total: 0 }),
    findById: async () => FAKE_PROPERTY,
    update: async () => FAKE_PROPERTY,
    archive: async () => FAKE_PROPERTY,
    ...overrides,
  };
}

function fakePropertyMediaRepository(overrides: Partial<PropertyMediaRepository> = {}): PropertyMediaRepository {
  return {
    create: async () => FAKE_MEDIA,
    listByProperty: async () => [FAKE_MEDIA],
    reorder: async () => [FAKE_MEDIA],
    setCover: async () => FAKE_MEDIA,
    delete: async () => ({ objectKey: FAKE_MEDIA.objectKey }),
    ...overrides,
  };
}

function fakeObjectStorage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    putObject: async (input: PutObjectInput): Promise<StoredObject> => ({
      key: input.key,
      publicUrl: `https://public-base.example/${input.key}`,
    }),
    deleteObject: async () => undefined,
    ...overrides,
  };
}

const UPLOAD_INPUT = {
  tenantId: "tenant-1",
  propertyId: FAKE_PROPERTY.id,
  mimeType: "image/jpeg" as const,
  body: Buffer.from("hello"),
  originalFilename: "foto.jpg",
};

describe("buildPropertyMediaObjectKey", () => {
  it("builds tenants/<tenant>/properties/<property>/<media>.<ext>, extension from mimeType", () => {
    expect(
      buildPropertyMediaObjectKey({
        tenantId: "tenant-1",
        propertyId: "prop-1",
        mediaId: "media-1",
        mimeType: "image/jpeg",
      }),
    ).toBe("tenants/tenant-1/properties/prop-1/media-1.jpg");
  });

  it.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ] as const)("maps %s to extension %s", (mimeType, extension) => {
    const key = buildPropertyMediaObjectKey({ tenantId: "t", propertyId: "p", mediaId: "m", mimeType });
    expect(key.endsWith(`.${extension}`)).toBe(true);
  });
});

describe("uploadPropertyMedia", () => {
  it("uploads to R2 then persists metadata, returning the created PropertyMedia", async () => {
    const result = await uploadPropertyMedia(
      fakePropertyRepository(),
      fakePropertyMediaRepository(),
      fakeObjectStorage(),
      UPLOAD_INPUT,
    );

    expect(result).toEqual(FAKE_MEDIA);
  });

  it("throws PropertyNotFoundError and never touches ObjectStorage when the property does not exist", async () => {
    const putCalls: PutObjectInput[] = [];
    const objectStorage = fakeObjectStorage({
      putObject: async (input) => {
        putCalls.push(input);
        return { key: input.key, publicUrl: "unused" };
      },
    });

    await expect(
      uploadPropertyMedia(
        fakePropertyRepository({ findById: async () => undefined }),
        fakePropertyMediaRepository(),
        objectStorage,
        UPLOAD_INPUT,
      ),
    ).rejects.toBeInstanceOf(PropertyNotFoundError);
    expect(putCalls).toHaveLength(0);
  });

  it("throws PropertyArchivedError and never touches ObjectStorage when the property is INACTIVE", async () => {
    const putCalls: PutObjectInput[] = [];
    const objectStorage = fakeObjectStorage({
      putObject: async (input) => {
        putCalls.push(input);
        return { key: input.key, publicUrl: "unused" };
      },
    });

    await expect(
      uploadPropertyMedia(
        fakePropertyRepository({ findById: async () => ({ ...FAKE_PROPERTY, status: "INACTIVE" }) }),
        fakePropertyMediaRepository(),
        objectStorage,
        UPLOAD_INPUT,
      ),
    ).rejects.toBeInstanceOf(PropertyArchivedError);
    expect(putCalls).toHaveLength(0);
  });

  it("allows upload for DRAFT and ACTIVE properties", async () => {
    for (const status of ["DRAFT", "ACTIVE"] as const) {
      await expect(
        uploadPropertyMedia(
          fakePropertyRepository({ findById: async () => ({ ...FAKE_PROPERTY, status }) }),
          fakePropertyMediaRepository(),
          fakeObjectStorage(),
          UPLOAD_INPUT,
        ),
      ).resolves.toEqual(FAKE_MEDIA);
    }
  });

  it("passes the generated object key/content type/body through to ObjectStorage.putObject", async () => {
    const putCalls: PutObjectInput[] = [];
    const objectStorage = fakeObjectStorage({
      putObject: async (input) => {
        putCalls.push(input);
        return { key: input.key, publicUrl: `https://public-base.example/${input.key}` };
      },
    });

    await uploadPropertyMedia(fakePropertyRepository(), fakePropertyMediaRepository(), objectStorage, UPLOAD_INPUT);

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]).toMatchObject({
      contentType: "image/jpeg",
      body: UPLOAD_INPUT.body,
      contentLength: UPLOAD_INPUT.body.length,
    });
    expect(putCalls[0]?.key).toMatch(
      new RegExp(`^tenants/tenant-1/properties/${FAKE_PROPERTY.id}/[0-9a-f-]{36}\\.jpg$`),
    );
  });

  describe("compensation on DB failure", () => {
    it("deletes the uploaded object and throws PropertyMediaPersistError(compensated: true), preserving the original error as cause", async () => {
      const deleteCalls: string[] = [];
      const dbError = new Error("insert failed");
      const objectStorage = fakeObjectStorage({
        deleteObject: async (key) => {
          deleteCalls.push(key);
        },
      });
      const mediaRepository = fakePropertyMediaRepository({
        create: async () => {
          throw dbError;
        },
      });

      const promise = uploadPropertyMedia(fakePropertyRepository(), mediaRepository, objectStorage, UPLOAD_INPUT);

      await expect(promise).rejects.toBeInstanceOf(PropertyMediaPersistError);
      try {
        await promise;
      } catch (error) {
        expect(error).toBeInstanceOf(PropertyMediaPersistError);
        const persistError = error as PropertyMediaPersistError;
        expect(persistError.compensated).toBe(true);
        expect(persistError.cause).toBe(dbError);
      }
      expect(deleteCalls).toHaveLength(1);
    });

    it("still throws PropertyMediaPersistError(compensated: false) with the original DB error preserved when the compensating delete also fails", async () => {
      const dbError = new Error("insert failed");
      const deleteError = new Error("R2 unreachable");
      const objectStorage = fakeObjectStorage({
        deleteObject: async () => {
          throw deleteError;
        },
      });
      const mediaRepository = fakePropertyMediaRepository({
        create: async () => {
          throw dbError;
        },
      });

      try {
        await uploadPropertyMedia(fakePropertyRepository(), mediaRepository, objectStorage, UPLOAD_INPUT);
        expect.fail("expected PropertyMediaPersistError");
      } catch (error) {
        expect(error).toBeInstanceOf(PropertyMediaPersistError);
        const persistError = error as PropertyMediaPersistError;
        expect(persistError.compensated).toBe(false);
        // The original DB error is what must survive — never replaced by the cleanup failure.
        expect(persistError.cause).toBe(dbError);
      }
    });
  });
});
