import { describe, expect, it } from "vitest";

import type { LeadWithPropertySummary } from "../domain/lead-property-summary.js";
import { listLeads } from "./list-leads.js";
import type { LeadRepository, ListLeadsInput } from "./lead-repository.js";

const SAMPLE_LEAD: LeadWithPropertySummary = {
  id: "11111111-1111-4111-8111-111111111111",
  propertyId: null,
  name: "Maria Souza",
  email: "maria@example.com",
  phone: null,
  status: "NEW",
  source: "MANUAL",
  message: null,
  notes: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  property: null,
};

function fakeRepository(overrides: Partial<LeadRepository> = {}): LeadRepository {
  return {
    create: async () => ({ ...SAMPLE_LEAD }),
    list: async () => ({ data: [SAMPLE_LEAD], total: 1 }),
    findById: async () => SAMPLE_LEAD,
    update: async () => SAMPLE_LEAD,
    ...overrides,
  };
}

function listInput(overrides: Partial<ListLeadsInput> = {}): ListLeadsInput {
  return { page: 1, limit: 20, filters: {}, sort: "created_at", order: "desc", ...overrides };
}

describe("listLeads", () => {
  it("returns the repository's data alongside computed pagination", async () => {
    const result = await listLeads(fakeRepository({ list: async () => ({ data: [SAMPLE_LEAD], total: 45 }) }), listInput({ page: 2, limit: 20 }));

    expect(result.data).toEqual([SAMPLE_LEAD]);
    expect(result.pagination).toEqual({ page: 2, limit: 20, total: 45, totalPages: 3 });
  });

  it("passes filters/sort/order through to the repository unchanged", async () => {
    const received: ListLeadsInput[] = [];
    const repository = fakeRepository({
      list: async (input) => {
        received.push(input);
        return { data: [], total: 0 };
      },
    });
    const input = listInput({ filters: { status: "NEW" }, sort: "name", order: "asc" });

    await listLeads(repository, input);

    expect(received).toEqual([input]);
  });
});
