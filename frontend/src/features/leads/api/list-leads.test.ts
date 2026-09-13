import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { listLeads } from "./list-leads";

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

describe("listLeads", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(validResponse());
  });

  it("calls GET /api/v1/leads with no query string when there are no filters", async () => {
    await listLeads("11111111-1111-1111-1111-111111111111", {});

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/leads",
      expect.objectContaining({
        headers: { "X-Tenant-Id": "11111111-1111-1111-1111-111111111111" },
      }),
    );
  });

  it("sends X-Tenant-Id and never any other tenant/auth header", async () => {
    await listLeads("11111111-1111-1111-1111-111111111111", { status: "NEW" });

    const [, options] = mockedApiFetch.mock.calls[0]!;
    expect(options?.headers).toEqual({ "X-Tenant-Id": "11111111-1111-1111-1111-111111111111" });
  });

  it("includes filled filters as query params", async () => {
    await listLeads("11111111-1111-1111-1111-111111111111", {
      q: "maria",
      status: "NEW",
      source: "WEBSITE",
      property_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      page: 2,
    });

    const [path] = mockedApiFetch.mock.calls[0]!;
    const query = new URLSearchParams(String(path).split("?")[1]);
    expect(query.get("q")).toBe("maria");
    expect(query.get("status")).toBe("NEW");
    expect(query.get("source")).toBe("WEBSITE");
    expect(query.get("property_id")).toBe("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    expect(query.get("page")).toBe("2");
  });

  it("expands a date-only created_from/created_to into full ISO day boundaries", async () => {
    await listLeads("11111111-1111-1111-1111-111111111111", {
      created_from: "2026-01-01",
      created_to: "2026-01-31",
    });

    const [path] = mockedApiFetch.mock.calls[0]!;
    const query = new URLSearchParams(String(path).split("?")[1]);
    expect(query.get("created_from")).toBe("2026-01-01T00:00:00.000Z");
    expect(query.get("created_to")).toBe("2026-01-31T23:59:59.999Z");
  });

  it("omits empty/undefined filters from the query string", async () => {
    await listLeads("11111111-1111-1111-1111-111111111111", { q: undefined, status: undefined });

    const [path] = mockedApiFetch.mock.calls[0]!;
    expect(String(path)).toBe("/api/v1/leads");
  });

  it("validates and returns the parsed response", async () => {
    const response = await listLeads("11111111-1111-1111-1111-111111111111", {});

    expect(response).toEqual(validResponse());
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ data: "not-an-array" });

    await expect(listLeads("11111111-1111-1111-1111-111111111111", {})).rejects.toThrow();
  });
});
