import { describe, expect, it } from "vitest";

import type { Property } from "../schemas/property.schema";
import { getPropertyCardImage } from "./get-property-card-image";

function property(overrides: Partial<Property>): Property {
  return {
    id: "p1",
    title: "Casa",
    description: null,
    property_type: "HOUSE",
    transaction_type: "SALE",
    status: "ACTIVE",
    price: "100.00",
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
    updated_at: "2026-01-01T00:00:00.000Z",
    cover: null,
    ...overrides,
  };
}

function variant(url: string) {
  return { url, mime_type: "image/webp", width: 100, height: 100, size_bytes: 100 };
}

describe("getPropertyCardImage", () => {
  it("prefers the card variant when available", () => {
    const p = property({
      cover: {
        id: "c1",
        public_url: "https://example.com/original.jpg",
        processing_status: "READY",
        variants: {
          thumbnail: variant("https://example.com/thumb.webp"),
          card: variant("https://example.com/card.webp"),
        },
      },
    });

    expect(getPropertyCardImage(p)).toBe("https://example.com/card.webp");
  });

  it("falls back to the thumbnail variant when there is no card", () => {
    const p = property({
      cover: {
        id: "c1",
        public_url: "https://example.com/original.jpg",
        processing_status: "READY",
        variants: { thumbnail: variant("https://example.com/thumb.webp"), card: null },
      },
    });

    expect(getPropertyCardImage(p)).toBe("https://example.com/thumb.webp");
  });

  it("falls back to the original public_url when there are no variants", () => {
    const p = property({
      cover: {
        id: "c1",
        public_url: "https://example.com/original.jpg",
        processing_status: "READY",
        variants: { thumbnail: null, card: null },
      },
    });

    expect(getPropertyCardImage(p)).toBe("https://example.com/original.jpg");
  });

  it("returns null when there is no cover", () => {
    expect(getPropertyCardImage(property({ cover: null }))).toBeNull();
  });

  it("is not affected by processing_status — it just picks the first URL that exists", () => {
    const p = property({
      cover: {
        id: "c1",
        public_url: "https://example.com/original.jpg",
        processing_status: "PROCESSING",
        variants: { thumbnail: null, card: null },
      },
    });

    expect(getPropertyCardImage(p)).toBe("https://example.com/original.jpg");

    const failed = property({
      cover: {
        id: "c2",
        public_url: "https://example.com/original-2.jpg",
        processing_status: "FAILED",
        variants: { thumbnail: variant("https://example.com/thumb-2.webp"), card: null },
      },
    });

    expect(getPropertyCardImage(failed)).toBe("https://example.com/thumb-2.webp");
  });
});
