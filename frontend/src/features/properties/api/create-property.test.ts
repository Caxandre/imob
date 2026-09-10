import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { createProperty } from "./create-property";
import type { PropertyFormOutput } from "../schemas/property-form.schema";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

function validInput(): PropertyFormOutput {
  return {
    title: "Apartamento no Centro",
    description: null,
    property_type: "APARTMENT",
    transaction_type: "SALE",
    status: "ACTIVE",
    price: "450000.00",
    bedrooms: 2,
    bathrooms: 1,
    parking_spaces: 1,
    area_m2: "80.00",
    street: null,
    number: null,
    complement: null,
    neighborhood: null,
    city: null,
    state: null,
    postal_code: null,
  };
}

function validResponse() {
  return {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    ...validInput(),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("createProperty", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(validResponse());
  });

  it("calls POST /api/v1/properties with X-Tenant-Id and the given body", async () => {
    const input = validInput();
    await createProperty(TENANT_ID, input);

    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/properties", {
      method: "POST",
      headers: { "X-Tenant-Id": TENANT_ID },
      body: input,
    });
  });

  it("validates and returns the parsed response", async () => {
    const result = await createProperty(TENANT_ID, validInput());

    expect(result).toEqual(validResponse());
  });

  it("never sends a cover field or anything the form doesn't produce", async () => {
    await createProperty(TENANT_ID, validInput());

    const [, options] = mockedApiFetch.mock.calls[0]!;
    expect(options?.body).not.toHaveProperty("cover");
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ id: "only-id" });

    await expect(createProperty(TENANT_ID, validInput())).rejects.toThrow();
  });
});
