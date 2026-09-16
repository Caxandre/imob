import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { capturePropertyLead } from "./capture-property-lead";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const VALID_INPUT = {
  name: "Maria Souza",
  email: "maria@example.com",
  phone: null,
  message: null,
};

describe("capturePropertyLead", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue({ id: "lead-1" });
  });

  it("calls POST /api/v1/public/properties/:propertyId/leads with X-Tenant-Id", async () => {
    await capturePropertyLead("tenant-1", "property-1", VALID_INPUT);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/public/properties/property-1/leads",
      {
        method: "POST",
        headers: { "X-Tenant-Id": "tenant-1" },
        body: VALID_INPUT,
      },
    );
  });

  it("sends only name/email/phone/message — never status/source/notes/property_id", async () => {
    await capturePropertyLead("tenant-1", "property-1", VALID_INPUT);

    const [, options] = mockedApiFetch.mock.calls[0]!;
    const body = options?.body as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["email", "message", "name", "phone"]);
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("source");
    expect(body).not.toHaveProperty("notes");
    expect(body).not.toHaveProperty("property_id");
  });

  it("validates and returns the parsed { id } response", async () => {
    const result = await capturePropertyLead("tenant-1", "property-1", VALID_INPUT);

    expect(result).toEqual({ id: "lead-1" });
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({});

    await expect(
      capturePropertyLead("tenant-1", "property-1", VALID_INPUT),
    ).rejects.toThrow();
  });
});
