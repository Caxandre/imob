import { describe, expect, it } from "vitest";

import type { TenantListItem } from "../domain/tenant.js";
import { listTenants } from "./list-tenants.js";
import type { ListTenantsInput, ListTenantsResult, TenantRepository } from "./tenant-repository.js";

function fakeRepository(result: ListTenantsResult): TenantRepository {
  return {
    createWithProvisioningIntent: async () => {
      throw new Error("not used in this test");
    },
    list: async () => result,
  };
}

function sampleInput(overrides: Partial<ListTenantsInput> = {}): ListTenantsInput {
  return { page: 1, limit: 20, filters: {}, ...overrides };
}

describe("listTenants", () => {
  it("computes totalPages from total/limit — never a separate database round trip", async () => {
    const data: TenantListItem[] = [];
    const output = await listTenants(fakeRepository({ data, total: 45 }), sampleInput({ page: 2, limit: 20 }));

    expect(output).toEqual({ data, pagination: { page: 2, limit: 20, total: 45, totalPages: 3 } });
  });

  it("reports 0 total pages when there is nothing to list", async () => {
    const output = await listTenants(fakeRepository({ data: [], total: 0 }), sampleInput({ page: 1, limit: 20 }));

    expect(output.pagination.totalPages).toBe(0);
  });

  it("passes page/limit/filters through to the repository unchanged", async () => {
    const received: ListTenantsInput[] = [];
    const repository: TenantRepository = {
      createWithProvisioningIntent: async () => {
        throw new Error("not used in this test");
      },
      list: async (input) => {
        received.push(input);
        return { data: [], total: 0 };
      },
    };

    const input = sampleInput({ page: 3, limit: 50, filters: { status: "READY", query: "central" } });

    await listTenants(repository, input);

    expect(received).toEqual([input]);
  });
});
