import { describe, expect, it } from "vitest";

import type { PropertyMediaWithVariants } from "../domain/property-media.js";
import { emptyPropertyMediaVariantSet } from "../domain/property-media-variant.js";
import { PropertyNotFoundError, type Property } from "../domain/property.js";
import { listPropertyMedia } from "./list-property-media.js";
import type { PropertyMediaRepository } from "./property-media-repository.js";
import type { PropertyRepository } from "./property-repository.js";

const FAKE_PROPERTY: Property = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Apartamento no Centro",
  description: null,
  propertyType: "APARTMENT",
  transactionType: "SALE",
  status: "INACTIVE",
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

const FAKE_MEDIA: PropertyMediaWithVariants = {
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
  variants: emptyPropertyMediaVariantSet(),
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

describe("listPropertyMedia", () => {
  it("returns the media list from the repository", async () => {
    await expect(
      listPropertyMedia(fakePropertyRepository(), fakePropertyMediaRepository(), FAKE_PROPERTY.id),
    ).resolves.toEqual([FAKE_MEDIA]);
  });

  it("throws PropertyNotFoundError when the property does not exist, never calling the media repository", async () => {
    const listCalls: string[] = [];
    const mediaRepository = fakePropertyMediaRepository({
      listByProperty: async (propertyId) => {
        listCalls.push(propertyId);
        return [FAKE_MEDIA];
      },
    });

    await expect(
      listPropertyMedia(fakePropertyRepository({ findById: async () => undefined }), mediaRepository, "missing-id"),
    ).rejects.toBeInstanceOf(PropertyNotFoundError);
    expect(listCalls).toHaveLength(0);
  });

  it("allows listing media for an INACTIVE (archived) property — archiving never hides media", async () => {
    await expect(
      listPropertyMedia(
        fakePropertyRepository({ findById: async () => ({ ...FAKE_PROPERTY, status: "INACTIVE" }) }),
        fakePropertyMediaRepository(),
        FAKE_PROPERTY.id,
      ),
    ).resolves.toEqual([FAKE_MEDIA]);
  });
});
