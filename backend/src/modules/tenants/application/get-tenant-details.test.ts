import { describe, expect, it } from "vitest";

import { TenantNotFoundError, type TenantDetails } from "../domain/tenant.js";
import { getTenantDetails } from "./get-tenant-details.js";
import type { TenantRepository } from "./tenant-repository.js";

function fakeRepository(overrides: Partial<TenantRepository> = {}): TenantRepository {
  return {
    createWithProvisioningIntent: async () => {
      throw new Error("not used in this test");
    },
    list: async () => {
      throw new Error("not used in this test");
    },
    findDetailsById: async () => null,
    ...overrides,
  };
}

const SAMPLE_DETAILS: TenantDetails = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme",
  status: "READY",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  database: null,
  latestProvisioningJob: null,
};

describe("getTenantDetails", () => {
  it("returns the repository's details unchanged", async () => {
    const repository = fakeRepository({ findDetailsById: async () => SAMPLE_DETAILS });

    const result = await getTenantDetails(repository, SAMPLE_DETAILS.id);

    expect(result).toEqual(SAMPLE_DETAILS);
  });

  it("throws TenantNotFoundError when the repository returns null", async () => {
    const repository = fakeRepository({ findDetailsById: async () => null });

    await expect(getTenantDetails(repository, "missing-id")).rejects.toThrow(TenantNotFoundError);
  });

  it("passes the id through to the repository unchanged", async () => {
    const received: string[] = [];
    const repository = fakeRepository({
      findDetailsById: async (id) => {
        received.push(id);
        return SAMPLE_DETAILS;
      },
    });

    await getTenantDetails(repository, "some-id");

    expect(received).toEqual(["some-id"]);
  });
});
