import { describe, expect, it } from "vitest";

import { PropertyNotFoundError, type Property } from "../domain/property.js";
import { updateProperty } from "./update-property.js";
import type { PropertyRepository, UpdatePropertyInput } from "./property-repository.js";

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
    update: async () => FAKE_PROPERTY,
    archive: async () => FAKE_PROPERTY,
    ...overrides,
  };
}

describe("updateProperty", () => {
  it("returns the updated property", async () => {
    await expect(updateProperty(fakeRepository(), FAKE_PROPERTY.id, { title: "Novo título" })).resolves.toEqual(
      FAKE_PROPERTY,
    );
  });

  it("passes the id and input through to the repository unchanged, without doing SQL itself", async () => {
    const received: { id: string; input: UpdatePropertyInput }[] = [];
    const repository = fakeRepository({
      update: async (id, input) => {
        received.push({ id, input });
        return FAKE_PROPERTY;
      },
    });

    await updateProperty(repository, FAKE_PROPERTY.id, { price: "475000.00" });

    expect(received).toEqual([{ id: FAKE_PROPERTY.id, input: { price: "475000.00" } }]);
  });

  it("throws PropertyNotFoundError when the repository finds nothing to update", async () => {
    const repository = fakeRepository({ update: async () => undefined });

    await expect(updateProperty(repository, "missing-id", { title: "x" })).rejects.toThrow(PropertyNotFoundError);
  });
});
