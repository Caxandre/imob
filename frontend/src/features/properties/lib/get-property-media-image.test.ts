import { describe, expect, it } from "vitest";

import type { PropertyMedia } from "../schemas/property-media.schema";
import {
  getPropertyDetailImageUrl,
  getPropertyThumbnailImageUrl,
} from "./get-property-media-image";

function variant(url: string) {
  return { url, mime_type: "image/webp", width: 100, height: 100, size_bytes: 100 };
}

function media(overrides: Partial<PropertyMedia> = {}): PropertyMedia {
  return {
    id: "m1",
    property_id: "p1",
    public_url: "https://example.com/original.jpg",
    mime_type: "image/jpeg",
    size_bytes: 1000,
    original_filename: "foto.jpg",
    position: 0,
    is_cover: true,
    processing_status: "READY",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    variants: { thumbnail: null, card: null, detail: null },
    ...overrides,
  };
}

describe("getPropertyDetailImageUrl", () => {
  it("prefers the detail variant when available", () => {
    const m = media({
      variants: {
        detail: variant("https://example.com/detail.webp"),
        card: variant("https://example.com/card.webp"),
        thumbnail: variant("https://example.com/thumb.webp"),
      },
    });

    expect(getPropertyDetailImageUrl(m)).toBe("https://example.com/detail.webp");
  });

  it("falls back to the card variant when there is no detail", () => {
    const m = media({
      variants: {
        detail: null,
        card: variant("https://example.com/card.webp"),
        thumbnail: variant("https://example.com/thumb.webp"),
      },
    });

    expect(getPropertyDetailImageUrl(m)).toBe("https://example.com/card.webp");
  });

  it("falls back to the thumbnail variant when there is no detail or card", () => {
    const m = media({
      variants: { detail: null, card: null, thumbnail: variant("https://example.com/thumb.webp") },
    });

    expect(getPropertyDetailImageUrl(m)).toBe("https://example.com/thumb.webp");
  });

  it("falls back to the original public_url when there are no variants at all (legacy READY)", () => {
    const m = media({ variants: { detail: null, card: null, thumbnail: null } });

    expect(getPropertyDetailImageUrl(m)).toBe("https://example.com/original.jpg");
  });

  it("uses the original when PROCESSING, since original is already usable", () => {
    const m = media({
      processing_status: "PROCESSING",
      variants: { detail: null, card: null, thumbnail: null },
    });

    expect(getPropertyDetailImageUrl(m)).toBe("https://example.com/original.jpg");
  });

  it("uses the original when FAILED, since original is already usable", () => {
    const m = media({
      processing_status: "FAILED",
      variants: { detail: null, card: null, thumbnail: null },
    });

    expect(getPropertyDetailImageUrl(m)).toBe("https://example.com/original.jpg");
  });
});

describe("getPropertyThumbnailImageUrl", () => {
  it("prefers the thumbnail variant when available", () => {
    const m = media({
      variants: {
        detail: variant("https://example.com/detail.webp"),
        card: variant("https://example.com/card.webp"),
        thumbnail: variant("https://example.com/thumb.webp"),
      },
    });

    expect(getPropertyThumbnailImageUrl(m)).toBe("https://example.com/thumb.webp");
  });

  it("falls back to the card variant when there is no thumbnail", () => {
    const m = media({
      variants: { detail: null, card: variant("https://example.com/card.webp"), thumbnail: null },
    });

    expect(getPropertyThumbnailImageUrl(m)).toBe("https://example.com/card.webp");
  });

  it("never uses the detail variant, even when it's the only one available", () => {
    const m = media({
      variants: { detail: variant("https://example.com/detail.webp"), card: null, thumbnail: null },
    });

    expect(getPropertyThumbnailImageUrl(m)).toBe("https://example.com/original.jpg");
  });

  it("falls back to the original public_url when there are no variants at all", () => {
    const m = media({ variants: { detail: null, card: null, thumbnail: null } });

    expect(getPropertyThumbnailImageUrl(m)).toBe("https://example.com/original.jpg");
  });
});
