import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { listProperties } from "./list-properties";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

function validResponse() {
  return {
    data: [],
    pagination: { page: 1, limit: 20, total: 0, total_pages: 0 },
  };
}

describe("listProperties", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(validResponse());
  });

  it("calls GET /api/v1/properties with no query string when there are no filters", async () => {
    await listProperties("11111111-1111-1111-1111-111111111111", {});

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/properties",
      expect.objectContaining({
        headers: { "X-Tenant-Id": "11111111-1111-1111-1111-111111111111" },
      }),
    );
  });

  it("sends X-Tenant-Id and never any other tenant/auth header", async () => {
    await listProperties("11111111-1111-1111-1111-111111111111", { city: "Recife" });

    const [, options] = mockedApiFetch.mock.calls[0]!;
    expect(options?.headers).toEqual({ "X-Tenant-Id": "11111111-1111-1111-1111-111111111111" });
  });

  it("includes filled filters and sort/order/page as query params", async () => {
    await listProperties("11111111-1111-1111-1111-111111111111", {
      city: "Recife",
      property_type: "APARTMENT",
      sort: "price",
      order: "asc",
      page: 3,
    });

    const [path] = mockedApiFetch.mock.calls[0]!;
    const query = new URLSearchParams(String(path).split("?")[1]);
    expect(query.get("city")).toBe("Recife");
    expect(query.get("property_type")).toBe("APARTMENT");
    expect(query.get("sort")).toBe("price");
    expect(query.get("order")).toBe("asc");
    expect(query.get("page")).toBe("3");
  });

  it("omits empty/undefined filters from the query string", async () => {
    await listProperties("11111111-1111-1111-1111-111111111111", {
      city: "Recife",
      state: undefined,
      q: undefined,
    });

    const [path] = mockedApiFetch.mock.calls[0]!;
    expect(String(path)).not.toContain("state=");
    expect(String(path)).not.toContain("q=");
  });

  it("validates and returns the parsed response", async () => {
    const response = await listProperties("11111111-1111-1111-1111-111111111111", {});

    expect(response).toEqual(validResponse());
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ data: "not-an-array" });

    await expect(listProperties("11111111-1111-1111-1111-111111111111", {})).rejects.toThrow();
  });
});
