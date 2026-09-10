import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routes } from "@/app/router/router";
import { ApiError } from "@/lib/http/api-error";

import { getPropertyById } from "@/features/properties/api/get-property";
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

vi.mock("@/features/properties/api/update-property", () => ({
  updateProperty: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockedGetPropertyById = vi.mocked(getPropertyById);
const mockedUpdateProperty = vi.mocked(updateProperty);

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

function renderPage(path = `/properties/${PROPERTY_ID}/edit`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}

beforeEach(() => {
  mockedGetPropertyById.mockReset();
  mockedUpdateProperty.mockReset();
});

describe("EditPropertyPage", () => {
  it("shows a skeleton before the property resolves, without empty inputs", () => {
    mockedGetPropertyById.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.queryByLabelText("Título *")).not.toBeInTheDocument();
  });

  it("hydrates the form from the loaded property", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());

    renderPage();

    expect(await screen.findByLabelText("Título *")).toHaveValue("Apartamento no Centro");
    expect(screen.getByLabelText("Preço *")).toHaveValue("450.000,00");
    expect(screen.getByLabelText("Quartos")).toHaveValue("2");
    expect(screen.getByLabelText("Rua")).toHaveValue("Rua Exemplo");
  });

  it("shows a not-found state on a 404, without rendering the form", async () => {
    mockedGetPropertyById.mockRejectedValue(new ApiError(404, "Property not found"));

    renderPage();

    expect(await screen.findByText("Imóvel não encontrado.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Título *")).not.toBeInTheDocument();
  });

  it("shows a not-found state for an obviously-invalid id, without any request", async () => {
    renderPage("/properties/abc/edit");

    await waitFor(() => {
      expect(screen.getByText("Imóvel não encontrado.")).toBeInTheDocument();
    });
    expect(mockedGetPropertyById).not.toHaveBeenCalled();
  });

  it("shows a generic error state and retries on a non-404 load error", async () => {
    mockedGetPropertyById.mockRejectedValue(new Error("boom"));

    renderPage();

    expect(await screen.findByText("Não foi possível carregar o imóvel.")).toBeInTheDocument();

    mockedGetPropertyById.mockResolvedValue(buildProperty());
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByLabelText("Título *")).toBeInTheDocument();
  });

  it("disables Save when nothing has changed", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());

    renderPage();

    expect(await screen.findByRole("button", { name: "Salvar" })).toBeDisabled();
    expect(mockedUpdateProperty).not.toHaveBeenCalled();
  });

  it("sends only the dirty field(s) on save", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());
    mockedUpdateProperty.mockResolvedValue(buildProperty({ title: "Novo título" }));

    const { router } = renderPage();
    await screen.findByLabelText("Título *");

    fireEvent.change(screen.getByLabelText("Título *"), { target: { value: "Novo título" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedUpdateProperty).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID, { title: "Novo título" });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/properties/${PROPERTY_ID}`));
  });

  it("sends an explicit null when a dirty nullable text field is cleared", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());
    mockedUpdateProperty.mockResolvedValue(buildProperty({ description: null }));

    renderPage();
    await screen.findByLabelText("Título *");

    fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedUpdateProperty).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID, { description: null });
    });
  });

  it("sends zero (not null) when a dirty numeric field is changed to zero", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());
    mockedUpdateProperty.mockResolvedValue(buildProperty({ bedrooms: 0 }));

    renderPage();
    await screen.findByLabelText("Título *");

    fireEvent.change(screen.getByLabelText("Quartos"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedUpdateProperty).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID, { bedrooms: 0 });
    });
  });

  it("shows a safe error message and stays on the page when the mutation fails", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());
    mockedUpdateProperty.mockRejectedValue(new Error("boom"));

    const { router } = renderPage();
    await screen.findByLabelText("Título *");

    fireEvent.change(screen.getByLabelText("Título *"), { target: { value: "Outro título" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Não foi possível salvar o imóvel.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/properties/${PROPERTY_ID}/edit`);
  });

  it("cancel navigates back to the property's detail page", async () => {
    mockedGetPropertyById.mockResolvedValue(buildProperty());

    const { router } = renderPage();
    await screen.findByLabelText("Título *");

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(router.state.location.pathname).toBe(`/properties/${PROPERTY_ID}`);
  });
});
