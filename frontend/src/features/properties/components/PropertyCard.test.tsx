import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { Property } from "../schemas/property.schema";
import { PropertyCard } from "./PropertyCard";

function renderCard(property: Property) {
  return render(
    <MemoryRouter>
      <PropertyCard property={property} />
    </MemoryRouter>,
  );
}

function property(overrides: Partial<Property> = {}): Property {
  return {
    id: "p1",
    title: "Casa na praia",
    description: null,
    property_type: "HOUSE",
    transaction_type: "SALE",
    status: "ACTIVE",
    price: "450000.00",
    bedrooms: 3,
    bathrooms: 2,
    parking_spaces: 1,
    area_m2: "120.00",
    street: null,
    number: null,
    complement: null,
    neighborhood: null,
    city: "Florianópolis",
    state: "SC",
    postal_code: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    cover: null,
    ...overrides,
  };
}

describe("PropertyCard", () => {
  it("links to the property's detail page", () => {
    renderCard(property({ id: "abc-123" }));

    expect(screen.getByRole("link")).toHaveAttribute("href", "/properties/abc-123");
  });

  it("renders title, location, formatted price and available attributes", () => {
    renderCard(property());

    expect(screen.getByText("Casa na praia")).toBeInTheDocument();
    expect(screen.getByText("Florianópolis / SC")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s*450\.000,00/)).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("120 m²")).toBeInTheDocument();
  });

  it("omits bedrooms/bathrooms/parking/area when they are null instead of showing 0", () => {
    renderCard(
      property({
        bedrooms: null,
        bathrooms: null,
        parking_spaces: null,
        area_m2: null,
      }),
    );

    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders the card image using getPropertyCardImage's priority", () => {
    renderCard(
      property({
        cover: {
          id: "c1",
          public_url: "https://example.com/original.jpg",
          processing_status: "READY",
          variants: {
            thumbnail: {
              url: "https://example.com/thumb.webp",
              mime_type: "image/webp",
              width: 320,
              height: 213,
              size_bytes: 1,
            },
            card: {
              url: "https://example.com/card.webp",
              mime_type: "image/webp",
              width: 640,
              height: 426,
              size_bytes: 1,
            },
          },
        },
      }),
    );

    const img = screen.getByRole("img", { name: "Casa na praia" });
    expect(img).toHaveAttribute("src", "https://example.com/card.webp");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("shows a placeholder when there is no cover", () => {
    renderCard(property({ cover: null }));

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
