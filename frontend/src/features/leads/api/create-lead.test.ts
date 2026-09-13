import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { createLead } from "./create-lead";

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
    status: "NEW",
    source: "MANUAL",
    message: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("createLead", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(validLeadResponse());
  });

  it("calls POST /api/v1/leads with the given body and X-Tenant-Id", async () => {
    const input = {
      name: "Maria Souza",
      email: "maria@example.com",
      phone: null,
      property_id: null,
      source: "MANUAL" as const,
      message: null,
      notes: null,
    };

    await createLead("tenant-1", input);

    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/leads", {
      method: "POST",
      headers: { "X-Tenant-Id": "tenant-1" },
      body: input,
    });
  });

  it("never includes a status key in the request body", async () => {
    const input = {
      name: "Maria Souza",
      email: "maria@example.com",
      phone: null,
      property_id: null,
      source: "MANUAL" as const,
      message: null,
      notes: null,
    };

    await createLead("tenant-1", input);

    const [, options] = mockedApiFetch.mock.calls[0]!;
    expect(options?.body).not.toHaveProperty("status");
  });

  it("validates and returns the parsed response", async () => {
    const result = await createLead("tenant-1", {
      name: "Maria Souza",
      email: "maria@example.com",
      phone: null,
      property_id: null,
      source: "MANUAL",
      message: null,
      notes: null,
    });

    expect(result).toEqual(validLeadResponse());
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ id: "l1" });

    await expect(
      createLead("tenant-1", {
        name: "Maria Souza",
        email: "maria@example.com",
        phone: null,
        property_id: null,
        source: "MANUAL",
        message: null,
        notes: null,
      }),
    ).rejects.toThrow();
  });
});
