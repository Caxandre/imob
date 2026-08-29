import { describe, expect, it } from "vitest";

import type { PropertyMedia } from "../domain/property-media.js";
import { PropertyNotFoundError, type Property } from "../domain/property.js";
import { reorderPropertyMedia } from "./reorder-property-media.js";
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

describe("reorderPropertyMedia", () => {
  it("delegates to the repository and returns the reordered gallery", async () => {
    await expect(
      reorderPropertyMedia(fakePropertyRepository(), fakePropertyMediaRepository(), FAKE_PROPERTY.id, [FAKE_MEDIA.id]),
    ).resolves.toEqual([FAKE_MEDIA]);
  });

  it("throws PropertyNotFoundError when the property does not exist, never calling the media repository", async () => {
    const reorderCalls: string[] = [];
    const mediaRepository = fakePropertyMediaRepository({
      reorder: async (propertyId) => {
        reorderCalls.push(propertyId);
        return [FAKE_MEDIA];
      },
    });

    await expect(
      reorderPropertyMedia(fakePropertyRepository({ findById: async () => undefined }), mediaRepository, "missing-id", []),
    ).rejects.toBeInstanceOf(PropertyNotFoundError);
    expect(reorderCalls).toHaveLength(0);
  });

  it("allows reordering for an INACTIVE (archived) property", async () => {
    await expect(
      reorderPropertyMedia(
        fakePropertyRepository({ findById: async () => ({ ...FAKE_PROPERTY, status: "INACTIVE" }) }),
        fakePropertyMediaRepository(),
        FAKE_PROPERTY.id,
        [FAKE_MEDIA.id],
      ),
    ).resolves.toEqual([FAKE_MEDIA]);
  });

  it("passes mediaIds through to the repository unchanged", async () => {
    const received: string[][] = [];
    const mediaRepository = fakePropertyMediaRepository({
      reorder: async (_propertyId, mediaIds) => {
        received.push(mediaIds);
        return [FAKE_MEDIA];
      },
    });

    await reorderPropertyMedia(fakePropertyRepository(), mediaRepository, FAKE_PROPERTY.id, ["a", "b", "c"]);

    expect(received).toEqual([["a", "b", "c"]]);
  });
});
