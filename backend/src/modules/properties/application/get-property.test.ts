import { describe, expect, it } from "vitest";

import { PropertyNotFoundError, type Property } from "../domain/property.js";
import { getProperty } from "./get-property.js";
import type { PropertyRepository } from "./property-repository.js";

const FAKE_PROPERTY: Property = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Apartamento no Centro",
  description: null,
  propertyType: "APARTMENT",
  transactionType: "SALE",
  status: "DRAFT",
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
    ...overrides,
  };
}

describe("getProperty", () => {
  it("returns the property found by the repository", async () => {
    await expect(getProperty(fakeRepository(), FAKE_PROPERTY.id)).resolves.toEqual(FAKE_PROPERTY);
  });

  it("throws PropertyNotFoundError when the repository finds nothing", async () => {
    const repository = fakeRepository({ findById: async () => undefined });

    await expect(getProperty(repository, "missing-id")).rejects.toThrow(PropertyNotFoundError);
  });
});
