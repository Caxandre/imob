import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routes } from "@/app/router/router";
import { createProperty } from "@/features/properties/api/create-property";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: "11111111-1111-1111-1111-111111111111" },
  requireTenantId: () => "11111111-1111-1111-1111-111111111111",
}));

vi.mock("@/features/properties/api/create-property", () => ({
  createProperty: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockedCreateProperty = vi.mocked(createProperty);

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: ["/properties/new"] });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}

function fillMinimalValidForm() {
  fireEvent.change(screen.getByLabelText("Título *"), { target: { value: "Apartamento no Centro" } });
  fireEvent.change(screen.getByLabelText("Preço *"), { target: { value: "450000,00" } });
}

beforeEach(() => {
  mockedCreateProperty.mockReset();
});

describe("NewPropertyPage", () => {
  it("renders the empty form with default enum values", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Novo imóvel" })).toBeInTheDocument();
    expect(screen.getByLabelText("Título *")).toHaveValue("");
    expect(screen.getByLabelText("Preço *")).toHaveValue("");
  });

  it("shows a validation error and never calls the API when title is missing", async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText("Preço *"), { target: { value: "450000,00" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Título é obrigatório")).toBeInTheDocument();
    expect(mockedCreateProperty).not.toHaveBeenCalled();
  });

  it("submits the normalized payload and navigates to the new property's detail page", async () => {
    mockedCreateProperty.mockResolvedValue({
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      title: "Apartamento no Centro",
      description: null,
      property_type: "APARTMENT",
      transaction_type: "SALE",
      status: "DRAFT",
      price: "450000.00",
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
    });

    const { router } = renderPage();
    fillMinimalValidForm();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedCreateProperty).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({ title: "Apartamento no Centro", price: "450000.00" }),
      );
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/properties/3fa85f64-5717-4562-b3fc-2c963f66afa6"),
    );
  });

  it("shows a safe error message in the form and does not navigate when the mutation fails", async () => {
    mockedCreateProperty.mockRejectedValue(new Error("boom"));

    const { router } = renderPage();
    fillMinimalValidForm();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Não foi possível salvar o imóvel.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/properties/new");
  });

  it("disables the submit button while the mutation is pending (no double-submit)", async () => {
    mockedCreateProperty.mockReturnValue(new Promise(() => {}));

    renderPage();
    fillMinimalValidForm();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByRole("button", { name: "Salvando..." })).toBeDisabled();
    expect(mockedCreateProperty).toHaveBeenCalledTimes(1);
  });

  it("cancel navigates back to /properties", () => {
    const { router } = renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(router.state.location.pathname).toBe("/properties");
  });
});
