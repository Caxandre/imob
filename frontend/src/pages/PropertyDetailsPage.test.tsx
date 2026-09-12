import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routes } from "@/app/router/router";
import { ApiError } from "@/lib/http/api-error";

import { archiveProperty } from "@/features/properties/api/archive-property";
import { getPropertyById } from "@/features/properties/api/get-property";
import { listPropertyMedia } from "@/features/properties/api/list-property-media";
import { updateProperty } from "@/features/properties/api/update-property";
import type { PropertyDetail } from "@/features/properties/schemas/property.schema";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: "11111111-1111-1111-1111-111111111111" },
  requireTenantId: () => "11111111-1111-1111-1111-111111111111",
}));

vi.mock("@/features/properties/api/get-property", () => ({
  getPropertyById: vi.fn(),
}));

vi.mock("@/features/properties/api/list-property-media", () => ({
  listPropertyMedia: vi.fn(),
}));

// Rendered by `PropertyLifecycleActions`, mounted in the header of this page (Prompt 042) —
// mocked here purely so these page-focused tests never make a real network call; lifecycle
// behavior itself is covered by `PropertyLifecycleActions.test.tsx`.
vi.mock("@/features/properties/api/update-property", () => ({
  updateProperty: vi.fn(),
}));
vi.mock("@/features/properties/api/archive-property", () => ({
  archiveProperty: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockedGetPropertyById = vi.mocked(getPropertyById);
const mockedListPropertyMedia = vi.mocked(listPropertyMedia);
const mockedUpdateProperty = vi.mocked(updateProperty);
const mockedArchiveProperty = vi.mocked(archiveProperty);

function buildProperty(overrides: Partial<PropertyDetail> = {}): PropertyDetail {
  return {
    id: PROPERTY_ID,
    title: "Apartamento no Centro",
    description: "Vista para o mar.",
    property_type: "APARTMENT",
    transaction_type: "SALE",
    status: "ACTIVE",
    price: "450000.00",
    bedrooms: 2,
    bathrooms: 1,
    parking_spaces: 1,
    area_m2: "80.00",
    street: "Rua Exemplo",
    number: "123",
    complement: null,
    neighborhood: "Centro",
    city: "São Paulo",
    state: "SP",
    postal_code: "01000-000",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderPage(path = `/properties/${PROPERTY_ID}`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedGetPropertyById.mockReset();
  mockedListPropertyMedia.mockReset();
  mockedUpdateProperty.mockReset();
  mockedArchiveProperty.mockReset();
});

describe("PropertyDetailsPage", () => {
  it("shows a skeleton before the property resolves", () => {
    mockedGetPropertyById.mockReturnValue(new Promise(() => {}));
    mockedListPropertyMedia.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.queryByText("Apartamento no Centro")).not.toBeInTheDocument();
  });

  it("renders title, price, location, features and description on success", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());
    mockedListPropertyMedia.mockResolvedValue({ data: [] });

    renderPage();

    expect(await screen.findByText("Apartamento no Centro")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s*450\.000,00/)).toBeInTheDocument();
    expect(screen.getByText(/São Paulo - SP/)).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("80 m²")).toBeInTheDocument();
    expect(screen.getByText("Vista para o mar.")).toBeInTheDocument();
  });

  it("does not render an empty description block when description is null", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty({ description: null }));
    mockedListPropertyMedia.mockResolvedValue({ data: [] });

    renderPage();

    await screen.findByText("Apartamento no Centro");
    expect(screen.queryByText("null")).not.toBeInTheDocument();
  });

  it("fetches the property and its media exactly once each, in parallel (no N+1)", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());
    mockedListPropertyMedia.mockResolvedValue({ data: [] });

    renderPage();

    await screen.findByText("Apartamento no Centro");
    expect(mockedGetPropertyById).toHaveBeenCalledTimes(1);
    expect(mockedGetPropertyById).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID);
    expect(mockedListPropertyMedia).toHaveBeenCalledTimes(1);
    expect(mockedListPropertyMedia).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID);
  });

  it("shows a not-found state on a 404 from the property endpoint, without rendering a gallery", async () => {
    mockedGetPropertyById.mockRejectedValue(new ApiError(404, "Property not found"));
    mockedListPropertyMedia.mockResolvedValue({ data: [] });

    renderPage();

    expect(await screen.findByText("Imóvel não encontrado.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows a generic error state and retries on a non-404 property error", async () => {
    mockedGetPropertyById.mockRejectedValue(new Error("boom"));
    mockedListPropertyMedia.mockResolvedValue({ data: [] });

    renderPage();

    expect(await screen.findByText("Não foi possível carregar o imóvel.")).toBeInTheDocument();

    mockedGetPropertyById.mockResolvedValue(buildProperty());
    screen.getByRole("button", { name: "Tentar novamente" }).click();

    expect(await screen.findByText("Apartamento no Centro")).toBeInTheDocument();
  });

  it("shows a media error without hiding the property's own data", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());
    mockedListPropertyMedia.mockRejectedValue(new Error("boom"));

    renderPage();

    expect(await screen.findByText("Apartamento no Centro")).toBeInTheDocument();
    expect(screen.getByText("Não foi possível carregar as fotos.")).toBeInTheDocument();
  });

  it("shows a not-found state for an obviously-invalid id, without any request", async () => {
    renderPage("/properties/abc");

    await waitFor(() => {
      expect(screen.getByText("Imóvel não encontrado.")).toBeInTheDocument();
    });
    expect(mockedGetPropertyById).not.toHaveBeenCalled();
    expect(mockedListPropertyMedia).not.toHaveBeenCalled();
  });

  it("links back to /properties", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());
    mockedListPropertyMedia.mockResolvedValue({ data: [] });

    renderPage();

    await screen.findByText("Apartamento no Centro");
    expect(screen.getByRole("link", { name: "Voltar para imóveis" })).toHaveAttribute(
      "href",
      "/properties",
    );
  });

  it("renders the lifecycle action matching the property's current status", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty({ status: "ACTIVE" }));
    mockedListPropertyMedia.mockResolvedValue({ data: [] });

    renderPage();

    expect(await screen.findByRole("button", { name: "Arquivar imóvel" })).toBeInTheDocument();
    expect(mockedUpdateProperty).not.toHaveBeenCalled();
    expect(mockedArchiveProperty).not.toHaveBeenCalled();
  });
});
