import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { getLeadById } from "./get-lead";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

function validLeadWithProperty() {
  return {
    id: "l1",
    property_id: "p1",
    name: "Maria Souza",
    email: "maria@example.com",
    phone: null,
    status: "NEW",
    source: "MANUAL",
    message: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    property: { id: "p1", title: "Apartamento no Centro", status: "ACTIVE" },
  };
}

describe("getLeadById", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(validLeadWithProperty());
  });

  it("calls GET /api/v1/leads/:id with X-Tenant-Id", async () => {
    await getLeadById("tenant-1", "l1");

    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/leads/l1", {
      headers: { "X-Tenant-Id": "tenant-1" },
    });
  });

  it("validates and returns the parsed response, including the property summary", async () => {
    const result = await getLeadById("tenant-1", "l1");

    expect(result).toEqual(validLeadWithProperty());
  });

  it("returns property: null when the lead has no association", async () => {
    mockedApiFetch.mockResolvedValue({ ...validLeadWithProperty(), property_id: null, property: null });

    const result = await getLeadById("tenant-1", "l1");

    expect(result.property).toBeNull();
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ id: "l1" });

    await expect(getLeadById("tenant-1", "l1")).rejects.toThrow();
  });
});
