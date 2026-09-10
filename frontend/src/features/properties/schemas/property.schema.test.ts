import { describe, expect, it } from "vitest";

import {
  propertyDetailSchema,
  propertyListResponseSchema,
  propertySchema,
} from "./property.schema";

function validProperty() {
  return {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    title: "Casa na praia",
    description: "Vista para o mar",
    property_type: "HOUSE",
    transaction_type: "SALE",
    status: "ACTIVE",
    price: "450000.00",
    bedrooms: 3,
    bathrooms: 2,
    parking_spaces: 1,
    area_m2: "120.00",
    street: "Rua das Flores",
    number: "100",
    complement: null,
    neighborhood: "Centro",
    city: "Florianópolis",
    state: "SC",
    postal_code: "88000-000",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    cover: {
      id: "cover-id",
      public_url: "https://cdn.example.com/original.jpg",
      processing_status: "READY",
      variants: {
        thumbnail: {
          url: "https://cdn.example.com/thumb.webp",
          mime_type: "image/webp",
          width: 320,
          height: 213,
          size_bytes: 12345,
        },
        card: {
          url: "https://cdn.example.com/card.webp",
          mime_type: "image/webp",
          width: 640,
          height: 426,
          size_bytes: 23456,
        },
      },
    },
  };
}

describe("propertySchema", () => {
  it("accepts a valid property with a cover", () => {
    const result = propertySchema.safeParse(validProperty());

    expect(result.success).toBe(true);
  });

  it("accepts a valid property with cover: null", () => {
    const result = propertySchema.safeParse({ ...validProperty(), cover: null });

    expect(result.success).toBe(true);
  });

  it("accepts nullable numeric fields as null, distinct from 0", () => {
    const result = propertySchema.safeParse({
      ...validProperty(),
      bedrooms: null,
      bathrooms: null,
      parking_spaces: null,
      area_m2: null,
    });

    expect(result.success).toBe(true);
  });

  it("rejects a response with an unknown status", () => {
    const result = propertySchema.safeParse({ ...validProperty(), status: "PUBLISHED" });

    expect(result.success).toBe(false);
  });

  it("rejects a response where price is a number instead of a decimal string", () => {
    const result = propertySchema.safeParse({ ...validProperty(), price: 450000 });

    expect(result.success).toBe(false);
  });

  it("rejects a cover missing the variants object", () => {
    const result = propertySchema.safeParse({
      ...validProperty(),
      cover: { id: "x", public_url: "https://example.com/x.jpg", processing_status: "READY" },
    });

    expect(result.success).toBe(false);
  });
});

describe("propertyDetailSchema", () => {
  function validPropertyDetail() {
    const detail: Record<string, unknown> = { ...validProperty() };
    delete detail.cover;
    return detail;
  }

  it("accepts the GET /api/v1/properties/:id response shape, which never has a cover", () => {
    const result = propertyDetailSchema.safeParse(validPropertyDetail());

    expect(result.success).toBe(true);
  });

  it("strips an unexpected cover field rather than rejecting the response", () => {
    const result = propertyDetailSchema.safeParse(validProperty());

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("cover");
  });

  it("rejects a response missing a required field", () => {
    const rest = validPropertyDetail();
    delete rest.title;

    const result = propertyDetailSchema.safeParse(rest);

    expect(result.success).toBe(false);
  });
});

describe("propertyListResponseSchema", () => {
  it("accepts a valid paginated list response", () => {
    const result = propertyListResponseSchema.safeParse({
      data: [validProperty()],
      pagination: { page: 1, limit: 20, total: 1, total_pages: 1 },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a response missing the pagination envelope", () => {
    const result = propertyListResponseSchema.safeParse({ data: [validProperty()] });

    expect(result.success).toBe(false);
  });
});
