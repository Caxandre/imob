import { describe, expect, it } from "vitest";

import type { Property } from "../domain/property.js";
import { createProperty } from "./create-property.js";
import type { CreatePropertyInput, PropertyRepository } from "./property-repository.js";

const BASE_INPUT: CreatePropertyInput = {
  title: "Apartamento no Centro",
  description: null,
  propertyType: "APARTMENT",
  transactionType: "SALE",
  status: "DRAFT",
  price: "450000.00",
  bedrooms: 3,
  bathrooms: 2,
  parkingSpaces: 1,
  areaM2: "92.50",
  street: null,
  number: null,
  complement: null,
  neighborhood: null,
  city: null,
  state: null,
  postalCode: null,
};

function fakeRepository(overrides: Partial<PropertyRepository> = {}): PropertyRepository {
  return {
    create: async (input: CreatePropertyInput): Promise<Property> => ({
      id: "11111111-1111-4111-8111-111111111111",
      ...input,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
    list: async () => ({ data: [], total: 0 }),
    findById: async () => undefined,
    ...overrides,
  };
}

describe("createProperty", () => {
  it("returns the persisted property", async () => {
    const property = await createProperty(fakeRepository(), BASE_INPUT);

    expect(property).toMatchObject({ title: "Apartamento no Centro", price: "450000.00" });
  });

  it("passes the input through to the repository unchanged, without doing SQL itself", async () => {
    const received: CreatePropertyInput[] = [];
    const repository = fakeRepository({
      create: async (input) => {
        received.push(input);
        return fakeRepository().create(input);
      },
    });

    await createProperty(repository, BASE_INPUT);

    expect(received).toEqual([BASE_INPUT]);
  });
});
