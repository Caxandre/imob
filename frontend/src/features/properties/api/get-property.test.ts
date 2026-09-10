import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { getPropertyById } from "./get-property";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

function validProperty() {
  return {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("getPropertyById", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(validProperty());
  });

  it("calls GET /api/v1/properties/:id with X-Tenant-Id", async () => {
    await getPropertyById(
      "11111111-1111-1111-1111-111111111111",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/properties/3fa85f64-5717-4562-b3fc-2c963f66afa6",
      { headers: { "X-Tenant-Id": "11111111-1111-1111-1111-111111111111" } },
    );
  });

  it("validates and returns the parsed response", async () => {
    const property = await getPropertyById(
      "11111111-1111-1111-1111-111111111111",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );

    expect(property).toEqual(validProperty());
  });

  it("never accepts a cover field (the detail response never carries one)", async () => {
    mockedApiFetch.mockResolvedValue({ ...validProperty(), cover: { id: "x" } });

    const property = await getPropertyById(
      "11111111-1111-1111-1111-111111111111",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );

    expect(property).not.toHaveProperty("cover");
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ id: "only-id" });

    await expect(
      getPropertyById(
        "11111111-1111-1111-1111-111111111111",
        "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      ),
    ).rejects.toThrow();
  });
});
