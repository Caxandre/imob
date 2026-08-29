import { describe, expect, it } from "vitest";

import type { ObjectStorage } from "../../../infrastructure/object-storage/object-storage.js";
import type { PropertyMedia } from "../domain/property-media.js";
import { PropertyMediaNotFoundError } from "../domain/property-media.js";
import { PropertyNotFoundError, type Property } from "../domain/property.js";
import { deletePropertyMedia } from "./delete-property-media.js";
import type { PropertyMediaRepository } from "./property-media-repository.js";
import type { PropertyRepository } from "./property-repository.js";

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
  processingStatus: "PROCESSING",
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
    delete: async () => ({ objectKey: FAKE_MEDIA.objectKey, variantObjectKeys: [] }),
    ...overrides,
  };
}

function fakeObjectStorage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    putObject: async (input) => ({ key: input.key, publicUrl: `https://public-base.example/${input.key}` }),
    getObject: async () => { throw new Error("getObject not implemented in this fake"); },
    deleteObject: async () => undefined,
    ...overrides,
  };
}

describe("deletePropertyMedia", () => {
  it("deletes the metadata then the original R2 object, reporting no failed keys", async () => {
    const deleteCalls: string[] = [];
    const objectStorage = fakeObjectStorage({
      deleteObject: async (key) => {
        deleteCalls.push(key);
      },
    });

    const outcome = await deletePropertyMedia(
      fakePropertyRepository(),
      fakePropertyMediaRepository(),
      objectStorage,
      FAKE_PROPERTY.id,
      FAKE_MEDIA.id,
    );

    expect(outcome).toEqual({ objectKeys: [FAKE_MEDIA.objectKey], failedObjectKeys: [] });
    expect(deleteCalls).toEqual([FAKE_MEDIA.objectKey]);
  });

  it("also deletes every variant object key the repository reports, alongside the original", async () => {
    const deleteCalls: string[] = [];
    const variantKeys = [
      `tenants/t/properties/p/${FAKE_MEDIA.id}/thumbnail.webp`,
      `tenants/t/properties/p/${FAKE_MEDIA.id}/card.webp`,
      `tenants/t/properties/p/${FAKE_MEDIA.id}/detail.webp`,
    ];
    const mediaRepository = fakePropertyMediaRepository({
      delete: async () => ({ objectKey: FAKE_MEDIA.objectKey, variantObjectKeys: variantKeys }),
    });
    const objectStorage = fakeObjectStorage({
      deleteObject: async (key) => {
        deleteCalls.push(key);
      },
    });

    const outcome = await deletePropertyMedia(
      fakePropertyRepository(),
      mediaRepository,
      objectStorage,
      FAKE_PROPERTY.id,
      FAKE_MEDIA.id,
    );

    expect(outcome).toEqual({ objectKeys: [FAKE_MEDIA.objectKey, ...variantKeys], failedObjectKeys: [] });
    expect(deleteCalls).toEqual([FAKE_MEDIA.objectKey, ...variantKeys]);
  });

  it("throws PropertyNotFoundError when the property does not exist, never touching the media repository or ObjectStorage", async () => {
    const mediaDeleteCalls: string[] = [];
    const objectStorageDeleteCalls: string[] = [];
    const mediaRepository = fakePropertyMediaRepository({
      delete: async (propertyId) => {
        mediaDeleteCalls.push(propertyId);
        return { objectKey: FAKE_MEDIA.objectKey, variantObjectKeys: [] };
      },
    });
    const objectStorage = fakeObjectStorage({
      deleteObject: async (key) => {
        objectStorageDeleteCalls.push(key);
      },
    });

    await expect(
      deletePropertyMedia(
        fakePropertyRepository({ findById: async () => undefined }),
        mediaRepository,
        objectStorage,
        "missing-id",
        FAKE_MEDIA.id,
      ),
    ).rejects.toBeInstanceOf(PropertyNotFoundError);
    expect(mediaDeleteCalls).toHaveLength(0);
    expect(objectStorageDeleteCalls).toHaveLength(0);
  });

  it("propagates PropertyMediaNotFoundError from the repository without ever calling ObjectStorage.deleteObject", async () => {
    const objectStorageDeleteCalls: string[] = [];
    const mediaRepository = fakePropertyMediaRepository({
      delete: async () => {
        throw new PropertyMediaNotFoundError(FAKE_MEDIA.id);
      },
    });
    const objectStorage = fakeObjectStorage({
      deleteObject: async (key) => {
        objectStorageDeleteCalls.push(key);
      },
    });

    await expect(
      deletePropertyMedia(fakePropertyRepository(), mediaRepository, objectStorage, FAKE_PROPERTY.id, FAKE_MEDIA.id),
    ).rejects.toBeInstanceOf(PropertyMediaNotFoundError);
    expect(objectStorageDeleteCalls).toHaveLength(0);
  });

  it("still resolves successfully (never throws) when the R2 delete fails, reporting the key as failed", async () => {
    const objectStorage = fakeObjectStorage({
      deleteObject: async () => {
        throw new Error("R2 unreachable");
      },
    });

    const outcome = await deletePropertyMedia(
      fakePropertyRepository(),
      fakePropertyMediaRepository(),
      objectStorage,
      FAKE_PROPERTY.id,
      FAKE_MEDIA.id,
    );

    expect(outcome).toEqual({ objectKeys: [FAKE_MEDIA.objectKey], failedObjectKeys: [FAKE_MEDIA.objectKey] });
  });

  it("attempts every key independently — one failing never stops the others from being attempted", async () => {
    const variantKeys = [
      `tenants/t/properties/p/${FAKE_MEDIA.id}/thumbnail.webp`,
      `tenants/t/properties/p/${FAKE_MEDIA.id}/card.webp`,
    ];
    const mediaRepository = fakePropertyMediaRepository({
      delete: async () => ({ objectKey: FAKE_MEDIA.objectKey, variantObjectKeys: variantKeys }),
    });
    const attempted: string[] = [];
    const objectStorage = fakeObjectStorage({
      deleteObject: async (key) => {
        attempted.push(key);
        if (key === FAKE_MEDIA.objectKey) {
          throw new Error("R2 unreachable for the original");
        }
      },
    });

    const outcome = await deletePropertyMedia(
      fakePropertyRepository(),
      mediaRepository,
      objectStorage,
      FAKE_PROPERTY.id,
      FAKE_MEDIA.id,
    );

    expect(attempted).toEqual([FAKE_MEDIA.objectKey, ...variantKeys]);
    expect(outcome.failedObjectKeys).toEqual([FAKE_MEDIA.objectKey]);
  });

  it("allows deleting media for an INACTIVE (archived) property", async () => {
    const outcome = await deletePropertyMedia(
      fakePropertyRepository({ findById: async () => ({ ...FAKE_PROPERTY, status: "INACTIVE" }) }),
      fakePropertyMediaRepository(),
      fakeObjectStorage(),
      FAKE_PROPERTY.id,
      FAKE_MEDIA.id,
    );

    expect(outcome.failedObjectKeys).toEqual([]);
  });
});
