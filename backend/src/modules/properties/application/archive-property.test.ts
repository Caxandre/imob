import { describe, expect, it } from "vitest";

import { PropertyNotFoundError, type Property } from "../domain/property.js";
import { archiveProperty } from "./archive-property.js";
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

function fakeRepository(overrides: Partial<PropertyRepository> = {}): PropertyRepository {
  return {
    create: async () => FAKE_PROPERTY,
    list: async () => ({ data: [], total: 0 }),
    findById: async () => FAKE_PROPERTY,
    update: async () => FAKE_PROPERTY,
    archive: async () => FAKE_PROPERTY,
    ...overrides,
  };
}

describe("archiveProperty", () => {
  it("returns the archived property", async () => {
    await expect(archiveProperty(fakeRepository(), FAKE_PROPERTY.id)).resolves.toEqual(FAKE_PROPERTY);
  });

  it("passes the id through to the repository unchanged, without doing SQL itself", async () => {
    const received: string[] = [];
    const repository = fakeRepository({
      archive: async (id) => {
        received.push(id);
        return FAKE_PROPERTY;
      },
    });

    await archiveProperty(repository, FAKE_PROPERTY.id);

    expect(received).toEqual([FAKE_PROPERTY.id]);
  });

  it("throws PropertyNotFoundError when the repository finds nothing to archive", async () => {
    const repository = fakeRepository({ archive: async () => undefined });

    await expect(archiveProperty(repository, "missing-id")).rejects.toThrow(PropertyNotFoundError);
  });
});
