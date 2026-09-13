import { describe, expect, it } from "vitest";

import { LeadNotFoundError } from "../domain/lead.js";
import type { LeadWithPropertySummary } from "../domain/lead-property-summary.js";
import { getLead } from "./get-lead.js";
import type { LeadRepository } from "./lead-repository.js";

const SAMPLE_LEAD: LeadWithPropertySummary = {
  id: "11111111-1111-4111-8111-111111111111",
  propertyId: "22222222-2222-4222-8222-222222222222",
  name: "Maria Souza",
  email: "maria@example.com",
  phone: null,
  status: "NEW",
  source: "MANUAL",
  message: null,
  notes: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  property: { id: "22222222-2222-4222-8222-222222222222", title: "Apartamento no Centro", status: "ACTIVE" },
};

function fakeRepository(overrides: Partial<LeadRepository> = {}): LeadRepository {
  return {
    create: async () => SAMPLE_LEAD,
    list: async () => ({ data: [], total: 0 }),
    findById: async () => SAMPLE_LEAD,
    update: async () => SAMPLE_LEAD,
    ...overrides,
  };
}

describe("getLead", () => {
  it("returns the lead including its property summary", async () => {
    await expect(getLead(fakeRepository(), SAMPLE_LEAD.id)).resolves.toEqual(SAMPLE_LEAD);
  });

  it("throws LeadNotFoundError when the repository finds nothing", async () => {
    const repository = fakeRepository({ findById: async () => undefined });

    await expect(getLead(repository, "missing-id")).rejects.toThrow(LeadNotFoundError);
  });
});
