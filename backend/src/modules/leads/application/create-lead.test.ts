import { describe, expect, it } from "vitest";

import type { Property } from "../../properties/domain/property.js";
import type { PropertyRepository } from "../../properties/application/property-repository.js";
import type { Lead } from "../domain/lead.js";
import { LeadPropertyNotFoundError } from "../domain/lead.js";
import { createLead } from "./create-lead.js";
import type { CreateLeadInput, LeadRepository } from "./lead-repository.js";

const BASE_INPUT: CreateLeadInput = {
  propertyId: null,
  name: "Maria Souza",
  email: "maria@example.com",
  phone: null,
  source: "MANUAL",
  message: "Tenho interesse neste apartamento.",
  notes: null,
};

const FAKE_PROPERTY: Property = {
  id: "22222222-2222-4222-8222-222222222222",
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

function fakeLeadRepository(overrides: Partial<LeadRepository> = {}): LeadRepository {
  return {
    create: async (input: CreateLeadInput): Promise<Lead> => ({
      id: "11111111-1111-4111-8111-111111111111",
      ...input,
      status: "NEW",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
    list: async () => ({ data: [], total: 0 }),
    findById: async () => undefined,
    update: async () => undefined,
    ...overrides,
  };
}

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

describe("createLead", () => {
  it("returns the persisted lead, always as NEW", async () => {
    const lead = await createLead(fakeLeadRepository(), fakePropertyRepository(), BASE_INPUT);

    expect(lead).toMatchObject({ name: "Maria Souza", status: "NEW" });
  });

  it("passes the input through to the repository unchanged, without doing SQL itself", async () => {
    const received: CreateLeadInput[] = [];
    const leadRepository = fakeLeadRepository({
      create: async (input) => {
        received.push(input);
        return fakeLeadRepository().create(input);
      },
    });

    await createLead(leadRepository, fakePropertyRepository(), BASE_INPUT);

    expect(received).toEqual([BASE_INPUT]);
  });

  it("never checks the property repository when propertyId is null", async () => {
    let called = false;
    const propertyRepository = fakePropertyRepository({
      findById: async () => {
        called = true;
        return FAKE_PROPERTY;
      },
    });

    await createLead(fakeLeadRepository(), propertyRepository, BASE_INPUT);

    expect(called).toBe(false);
  });

  it("verifies the property exists in this tenant's database when propertyId is set", async () => {
    const received: string[] = [];
    const propertyRepository = fakePropertyRepository({
      findById: async (id) => {
        received.push(id);
        return FAKE_PROPERTY;
      },
    });

    await createLead(fakeLeadRepository(), propertyRepository, {
      ...BASE_INPUT,
      propertyId: FAKE_PROPERTY.id,
    });

    expect(received).toEqual([FAKE_PROPERTY.id]);
  });

  it("throws LeadPropertyNotFoundError when the property does not exist in this tenant", async () => {
    const propertyRepository = fakePropertyRepository({ findById: async () => undefined });

    await expect(
      createLead(fakeLeadRepository(), propertyRepository, { ...BASE_INPUT, propertyId: "missing-id" }),
    ).rejects.toThrow(LeadPropertyNotFoundError);
  });

  it("allows a property reference regardless of the property's status (e.g. INACTIVE)", async () => {
    const propertyRepository = fakePropertyRepository({
      findById: async () => ({ ...FAKE_PROPERTY, status: "INACTIVE" }),
    });

    await expect(
      createLead(fakeLeadRepository(), propertyRepository, { ...BASE_INPUT, propertyId: FAKE_PROPERTY.id }),
    ).resolves.toMatchObject({ status: "NEW" });
  });
});
