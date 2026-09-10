import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { updateProperty } from "./update-property";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function validResponse() {
  return {
    id: PROPERTY_ID,
    title: "Apartamento no Centro (atualizado)",
    description: null,
    property_type: "APARTMENT",
    transaction_type: "SALE",
    status: "ACTIVE",
    price: "475000.00",
    bedrooms: null,
    bathrooms: null,
    parking_spaces: null,
    area_m2: null,
    street: null,
    number: null,
    complement: null,
    neighborhood: null,
    city: null,
    state: null,
    postal_code: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
}

describe("updateProperty", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(validResponse());
  });

  it("calls PATCH /api/v1/properties/:id with X-Tenant-Id and exactly the given partial body", async () => {
    await updateProperty(TENANT_ID, PROPERTY_ID, { title: "Novo título" });

    expect(mockedApiFetch).toHaveBeenCalledWith(`/api/v1/properties/${PROPERTY_ID}`, {
      method: "PATCH",
      headers: { "X-Tenant-Id": TENANT_ID },
      body: { title: "Novo título" },
    });
  });

  it("sends an explicit null to clear a nullable field, never omitting it", async () => {
    await updateProperty(TENANT_ID, PROPERTY_ID, { description: null });

    const [, options] = mockedApiFetch.mock.calls[0]!;
    expect(options?.body).toEqual({ description: null });
    expect(options?.body).toHaveProperty("description", null);
  });

  it("never includes a field that wasn't passed in", async () => {
    await updateProperty(TENANT_ID, PROPERTY_ID, { price: "475000.00" });

    const [, options] = mockedApiFetch.mock.calls[0]!;
    expect(Object.keys(options?.body as object)).toEqual(["price"]);
  });

  it("validates and returns the parsed response", async () => {
    const result = await updateProperty(TENANT_ID, PROPERTY_ID, { title: "x" });

    expect(result).toEqual(validResponse());
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ id: "only-id" });

    await expect(updateProperty(TENANT_ID, PROPERTY_ID, { title: "x" })).rejects.toThrow();
  });
});
