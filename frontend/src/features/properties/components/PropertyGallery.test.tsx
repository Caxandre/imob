import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PropertyMedia } from "../schemas/property-media.schema";
import { PropertyGallery } from "./PropertyGallery";

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
    is_cover: false,
    processing_status: "READY",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    variants: { thumbnail: null, card: null, detail: null },
    ...overrides,
  };
}

describe("PropertyGallery", () => {
  it("shows a large placeholder when there is no media", () => {
    render(<PropertyGallery media={[]} title="Casa na praia" />);

    expect(screen.getByText("Imóvel sem fotos")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("selects the cover media first, even if it is not position 0", () => {
    const items = [
      media({
        id: "a",
        position: 0,
        is_cover: false,
        variants: {
          thumbnail: null,
          card: null,
          detail: variant("https://example.com/a-detail.webp"),
        },
      }),
      media({
        id: "b",
        position: 1,
        is_cover: true,
        variants: {
          thumbnail: null,
          card: null,
          detail: variant("https://example.com/b-detail.webp"),
        },
      }),
    ];

    render(<PropertyGallery media={items} title="Casa na praia" />);

    expect(screen.getByRole("img", { name: "Casa na praia" })).toHaveAttribute(
      "src",
      "https://example.com/b-detail.webp",
    );
  });

  it("falls back to the first media by position when there is no cover", () => {
    const items = [
      media({
        id: "a",
        position: 1,
        is_cover: false,
        variants: {
          thumbnail: null,
          card: null,
          detail: variant("https://example.com/a-detail.webp"),
        },
      }),
      media({
        id: "b",
        position: 0,
        is_cover: false,
        variants: {
          thumbnail: null,
          card: null,
          detail: variant("https://example.com/b-detail.webp"),
        },
      }),
    ];

    render(<PropertyGallery media={items} title="Casa na praia" />);

    expect(screen.getByRole("img", { name: "Casa na praia" })).toHaveAttribute(
      "src",
      "https://example.com/b-detail.webp",
    );
  });

  it("uses the DETAIL variant for the main image when available", () => {
    const item = media({
      is_cover: true,
      variants: {
        thumbnail: variant("https://example.com/thumb.webp"),
        card: variant("https://example.com/card.webp"),
        detail: variant("https://example.com/detail.webp"),
      },
    });

    render(<PropertyGallery media={[item]} title="Casa na praia" />);

    expect(screen.getByRole("img", { name: "Casa na praia" })).toHaveAttribute(
      "src",
      "https://example.com/detail.webp",
    );
  });

  it("falls back to CARD for the main image when there is no DETAIL", () => {
    const item = media({
      is_cover: true,
      variants: {
        thumbnail: variant("https://example.com/thumb.webp"),
        card: variant("https://example.com/card.webp"),
        detail: null,
      },
    });

    render(<PropertyGallery media={[item]} title="Casa na praia" />);

    expect(screen.getByRole("img", { name: "Casa na praia" })).toHaveAttribute(
      "src",
      "https://example.com/card.webp",
    );
  });

  it("falls back to THUMBNAIL for the main image when there is no DETAIL or CARD", () => {
    const item = media({
      is_cover: true,
      variants: { thumbnail: variant("https://example.com/thumb.webp"), card: null, detail: null },
    });

    render(<PropertyGallery media={[item]} title="Casa na praia" />);

    expect(screen.getByRole("img", { name: "Casa na praia" })).toHaveAttribute(
      "src",
      "https://example.com/thumb.webp",
    );
  });

  it("falls back to the original public_url for the main image (legacy READY, no variants)", () => {
    const item = media({
      is_cover: true,
      variants: { thumbnail: null, card: null, detail: null },
    });

    render(<PropertyGallery media={[item]} title="Casa na praia" />);

    expect(screen.getByRole("img", { name: "Casa na praia" })).toHaveAttribute(
      "src",
      "https://example.com/original.jpg",
    );
  });

  it("shows original media and a discreet badge while PROCESSING", () => {
    const item = media({
      is_cover: true,
      processing_status: "PROCESSING",
      variants: { thumbnail: null, card: null, detail: null },
    });

    render(<PropertyGallery media={[item]} title="Casa na praia" />);

    expect(screen.getByRole("img", { name: "Casa na praia" })).toHaveAttribute(
      "src",
      "https://example.com/original.jpg",
    );
    expect(screen.getByText("Processando")).toBeInTheDocument();
  });

  it("shows original media when FAILED, without hiding the image", () => {
    const item = media({
      is_cover: true,
      processing_status: "FAILED",
      variants: { thumbnail: null, card: null, detail: null },
    });

    render(<PropertyGallery media={[item]} title="Casa na praia" />);

    expect(screen.getByRole("img", { name: "Casa na praia" })).toHaveAttribute(
      "src",
      "https://example.com/original.jpg",
    );
  });

  it("never uses DETAIL for thumbnails — falls back THUMBNAIL -> CARD -> original", () => {
    const items = [
      media({
        id: "a",
        is_cover: true,
        variants: {
          thumbnail: variant("https://example.com/a-thumb.webp"),
          card: null,
          detail: variant("https://example.com/a-detail.webp"),
        },
      }),
      media({
        id: "b",
        position: 1,
        variants: {
          thumbnail: null,
          card: variant("https://example.com/b-card.webp"),
          detail: null,
        },
      }),
    ];

    render(<PropertyGallery media={items} title="Casa na praia" />);

    const thumbnailButtons = screen.getAllByRole("button");
    expect(thumbnailButtons).toHaveLength(2);
    expect(thumbnailButtons[0]?.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/a-thumb.webp",
    );
    expect(thumbnailButtons[1]?.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/b-card.webp",
    );
  });

  it("does not render a thumbnail strip when there is only one photo", () => {
    render(<PropertyGallery media={[media({ is_cover: true })]} title="Casa na praia" />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("switches the main image when a thumbnail is clicked", () => {
    const items = [
      media({
        id: "a",
        is_cover: true,
        variants: {
          thumbnail: null,
          card: null,
          detail: variant("https://example.com/a-detail.webp"),
        },
      }),
      media({
        id: "b",
        position: 1,
        variants: {
          thumbnail: null,
          card: null,
          detail: variant("https://example.com/b-detail.webp"),
        },
      }),
    ];

    render(<PropertyGallery media={items} title="Casa na praia" />);

    expect(screen.getByRole("img", { name: "Casa na praia" })).toHaveAttribute(
      "src",
      "https://example.com/a-detail.webp",
    );

    fireEvent.click(screen.getByRole("button", { name: "Foto 2" }));

    expect(screen.getByRole("img", { name: "Casa na praia" })).toHaveAttribute(
      "src",
      "https://example.com/b-detail.webp",
    );
  });
});
