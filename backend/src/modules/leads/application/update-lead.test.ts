import { describe, expect, it } from "vitest";

import type { PropertyRepository } from "../../properties/application/property-repository.js";
import type { Property } from "../../properties/domain/property.js";
import {
  LeadContactChannelRequiredError,
  LeadNotFoundError,
  LeadPropertyNotFoundError,
  type Lead,
} from "../domain/lead.js";
import type { LeadWithPropertySummary } from "../domain/lead-property-summary.js";
import { updateLead } from "./update-lead.js";
import type { LeadRepository, UpdateLeadInput } from "./lead-repository.js";

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

function leadWithContact(overrides: Partial<LeadWithPropertySummary> = {}): LeadWithPropertySummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    propertyId: null,
    name: "Maria Souza",
    email: "maria@example.com",
    phone: "11999990000",
    status: "NEW",
    source: "MANUAL",
    message: null,
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    property: null,
    ...overrides,
  };
}

function fakeLeadRepository(overrides: Partial<LeadRepository> = {}): LeadRepository {
  const existing = leadWithContact();
  return {
    create: async () => existing,
    list: async () => ({ data: [], total: 0 }),
    findById: async () => existing,
    update: async (_id, input) => ({ ...(existing as Lead), ...input }),
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

describe("updateLead", () => {
  it("returns the updated lead", async () => {
    const lead = leadWithContact();
    const repository = fakeLeadRepository({
      findById: async () => lead,
      update: async () => ({ ...lead, name: "Novo nome" }),
    });

    await expect(updateLead(repository, fakePropertyRepository(), lead.id, { name: "Novo nome" })).resolves.toMatchObject({
      name: "Novo nome",
    });
  });

  it("passes the id and input through to the repository unchanged", async () => {
    const lead = leadWithContact();
    const received: { id: string; input: UpdateLeadInput }[] = [];
    const repository = fakeLeadRepository({
      findById: async () => lead,
      update: async (id, input) => {
        received.push({ id, input });
        return { ...lead, ...input };
      },
    });

    await updateLead(repository, fakePropertyRepository(), lead.id, { status: "CONTACTED" });

    expect(received).toEqual([{ id: lead.id, input: { status: "CONTACTED" } }]);
  });

  it("throws LeadNotFoundError when the lead does not exist", async () => {
    const repository = fakeLeadRepository({ findById: async () => undefined });

    await expect(updateLead(repository, fakePropertyRepository(), "missing-id", { name: "x" })).rejects.toThrow(
      LeadNotFoundError,
    );
  });

  it("verifies a new property_id exists in this tenant's database", async () => {
    const lead = leadWithContact();
    const received: string[] = [];
    const propertyRepository = fakePropertyRepository({
      findById: async (id) => {
        received.push(id);
        return FAKE_PROPERTY;
      },
    });

    await updateLead(fakeLeadRepository({ findById: async () => lead }), propertyRepository, lead.id, {
      propertyId: FAKE_PROPERTY.id,
    });

    expect(received).toEqual([FAKE_PROPERTY.id]);
  });

  it("throws LeadPropertyNotFoundError when the new property_id does not exist", async () => {
    const lead = leadWithContact();
    const propertyRepository = fakePropertyRepository({ findById: async () => undefined });

    await expect(
      updateLead(fakeLeadRepository({ findById: async () => lead }), propertyRepository, lead.id, {
        propertyId: "missing-id",
      }),
    ).rejects.toThrow(LeadPropertyNotFoundError);
  });

  it("allows clearing property_id to null without checking the property repository", async () => {
    const lead = leadWithContact({ propertyId: FAKE_PROPERTY.id });
    let called = false;
    const propertyRepository = fakePropertyRepository({
      findById: async () => {
        called = true;
        return undefined;
      },
    });

    await updateLead(fakeLeadRepository({ findById: async () => lead }), propertyRepository, lead.id, {
      propertyId: null,
    });

    expect(called).toBe(false);
  });

  it("allows clearing email when phone remains", async () => {
    const lead = leadWithContact({ email: "maria@example.com", phone: "11999990000" });
    const repository = fakeLeadRepository({ findById: async () => lead });

    await expect(
      updateLead(repository, fakePropertyRepository(), lead.id, { email: null }),
    ).resolves.toMatchObject({ email: null });
  });

  it("allows clearing phone when email remains", async () => {
    const lead = leadWithContact({ email: "maria@example.com", phone: "11999990000" });
    const repository = fakeLeadRepository({ findById: async () => lead });

    await expect(
      updateLead(repository, fakePropertyRepository(), lead.id, { phone: null }),
    ).resolves.toMatchObject({ phone: null });
  });

  it("rejects clearing the only remaining contact channel (email null, phone already null)", async () => {
    const lead = leadWithContact({ email: "maria@example.com", phone: null });
    const repository = fakeLeadRepository({ findById: async () => lead });

    await expect(updateLead(repository, fakePropertyRepository(), lead.id, { email: null })).rejects.toThrow(
      LeadContactChannelRequiredError,
    );
  });

  it("rejects clearing the only remaining contact channel (phone null, email already null)", async () => {
    const lead = leadWithContact({ email: null, phone: "11999990000" });
    const repository = fakeLeadRepository({ findById: async () => lead });

    await expect(updateLead(repository, fakePropertyRepository(), lead.id, { phone: null })).rejects.toThrow(
      LeadContactChannelRequiredError,
    );
  });

  it("rejects clearing both channels in the same request", async () => {
    const lead = leadWithContact();
    const repository = fakeLeadRepository({ findById: async () => lead });

    await expect(
      updateLead(repository, fakePropertyRepository(), lead.id, { email: null, phone: null }),
    ).rejects.toThrow(LeadContactChannelRequiredError);
  });

  it("never calls repository.update when the contact invariant would be violated", async () => {
    const lead = leadWithContact({ email: "maria@example.com", phone: null });
    let updateCalled = false;
    const repository = fakeLeadRepository({
      findById: async () => lead,
      update: async () => {
        updateCalled = true;
        return lead;
      },
    });

    await expect(updateLead(repository, fakePropertyRepository(), lead.id, { email: null })).rejects.toThrow();
    expect(updateCalled).toBe(false);
  });

  it("throws LeadNotFoundError if the repository's update reports the lead is gone", async () => {
    const lead = leadWithContact();
    const repository = fakeLeadRepository({ findById: async () => lead, update: async () => undefined });

    await expect(updateLead(repository, fakePropertyRepository(), lead.id, { name: "x" })).rejects.toThrow(
      LeadNotFoundError,
    );
  });
});
