import { describe, expect, it } from "vitest";

import type { Property } from "../domain/property.js";
import { listProperties } from "./list-properties.js";
import type { ListPropertiesInput, ListPropertiesResult, PropertyRepository } from "./property-repository.js";

function fakeRepository(result: ListPropertiesResult): PropertyRepository {
  return {
    create: async () => {
      throw new Error("not used in this test");
    },
    list: async () => result,
    findById: async () => undefined,
    update: async () => undefined,
    archive: async () => undefined,
  };
}

describe("listProperties", () => {
  it("computes totalPages from total/limit — never a separate database round trip", async () => {
    const data: Property[] = [];
    const output = await listProperties(fakeRepository({ data, total: 45 }), { page: 2, limit: 20 });

    expect(output).toEqual({ data, pagination: { page: 2, limit: 20, total: 45, totalPages: 3 } });
  });

  it("reports 0 total pages when there is nothing to list", async () => {
    const output = await listProperties(fakeRepository({ data: [], total: 0 }), { page: 1, limit: 20 });

    expect(output.pagination.totalPages).toBe(0);
  });

  it("passes page/limit through to the repository unchanged", async () => {
    const received: ListPropertiesInput[] = [];
    const repository: PropertyRepository = {
      create: async () => {
        throw new Error("not used in this test");
      },
      list: async (input) => {
        received.push(input);
        return { data: [], total: 0 };
      },
      findById: async () => undefined,
      update: async () => undefined,
      archive: async () => undefined,
    };

    await listProperties(repository, { page: 3, limit: 50 });

    expect(received).toEqual([{ page: 3, limit: 50 }]);
  });
});
