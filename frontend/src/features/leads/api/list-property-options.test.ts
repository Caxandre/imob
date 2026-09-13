import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { listPropertyOptions } from "./list-property-options";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

function response(overrides: { data?: unknown[]; total?: number } = {}) {
  return {
    data: overrides.data ?? [{ id: "p1", title: "Casa na Praia", status: "ACTIVE" }],
    pagination: { page: 1, limit: 100, total: overrides.total ?? 1, total_pages: 1 },
  };
}

describe("listPropertyOptions", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(response());
  });

  it("requests a single bounded page (limit=100) with X-Tenant-Id", async () => {
    await listPropertyOptions("tenant-1");

    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/properties?limit=100", {
      headers: { "X-Tenant-Id": "tenant-1" },
    });
  });

  it("returns only id/title/status, ignoring the rest of the Property shape", async () => {
    mockedApiFetch.mockResolvedValue(
      response({
        data: [{ id: "p1", title: "Casa", status: "ACTIVE", price: "1.00", cover: null }],
      }),
    );

    const result = await listPropertyOptions("tenant-1");

    expect(result.options).toEqual([{ id: "p1", title: "Casa", status: "ACTIVE" }]);
  });

  it("reports truncated: false when every property fit in the page", async () => {
    const result = await listPropertyOptions("tenant-1");

    expect(result.truncated).toBe(false);
  });

  it("reports truncated: true when total exceeds the returned page", async () => {
    mockedApiFetch.mockResolvedValue(response({ total: 250 }));

    const result = await listPropertyOptions("tenant-1");

    expect(result.truncated).toBe(true);
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ data: "not-an-array" });

    await expect(listPropertyOptions("tenant-1")).rejects.toThrow();
  });
});
