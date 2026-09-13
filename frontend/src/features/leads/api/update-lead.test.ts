import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { updateLead } from "./update-lead";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

function validLeadResponse() {
  return {
    id: "l1",
    property_id: null,
    name: "Maria Souza",
    email: "maria@example.com",
    phone: null,
    status: "CONTACTED",
    source: "MANUAL",
    message: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
}

describe("updateLead", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(validLeadResponse());
  });

  it("calls PATCH /api/v1/leads/:id with only the given partial body", async () => {
    await updateLead("tenant-1", "l1", { status: "CONTACTED" });

    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/leads/l1", {
      method: "PATCH",
      headers: { "X-Tenant-Id": "tenant-1" },
      body: { status: "CONTACTED" },
    });
  });

  it("sends an explicit null to clear a nullable field", async () => {
    await updateLead("tenant-1", "l1", { email: null });

    const [, options] = mockedApiFetch.mock.calls[0]!;
    expect(options?.body).toEqual({ email: null });
  });

  it("never sends a key that was not part of the partial input", async () => {
    await updateLead("tenant-1", "l1", { phone: "11999990000" });

    const [, options] = mockedApiFetch.mock.calls[0]!;
    expect(Object.keys(options?.body as object)).toEqual(["phone"]);
  });

  it("validates and returns the parsed response", async () => {
    const result = await updateLead("tenant-1", "l1", { status: "CONTACTED" });

    expect(result).toEqual(validLeadResponse());
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ id: "l1" });

    await expect(updateLead("tenant-1", "l1", { status: "CONTACTED" })).rejects.toThrow();
  });
});
