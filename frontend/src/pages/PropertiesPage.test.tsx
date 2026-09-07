import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routes } from "@/app/router/router";
import { listProperties } from "@/features/properties/api/list-properties";
import type { PropertyListResponse } from "@/features/properties/schemas/property.schema";

// `vi.mock` factories are hoisted above the rest of the module — they can't close over a
// top-level `const` declared below them, so the tenant id is inlined here instead.
vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: "11111111-1111-1111-1111-111111111111" },
  requireTenantId: () => "11111111-1111-1111-1111-111111111111",
}));

vi.mock("@/features/properties/api/list-properties", () => ({
  listProperties: vi.fn(),
}));

const mockedListProperties = vi.mocked(listProperties);

function buildResponse(overrides: Partial<PropertyListResponse> = {}): PropertyListResponse {
  return {
    data: [
      {
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
      },
    ],
    pagination: { page: 1, limit: 20, total: 1, total_pages: 1 },
    ...overrides,
  };
}

function renderPropertiesPage(initialEntries: string[] = ["/properties"]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries });

  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return { ...utils, router };
}

beforeEach(() => {
  mockedListProperties.mockReset();
});

describe("PropertiesPage", () => {
  it("shows a loading skeleton before data resolves", () => {
    mockedListProperties.mockReturnValue(new Promise(() => {}));

    const { container } = renderPropertiesPage();

    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(6);
  });

  it("renders property cards on success", async () => {
    mockedListProperties.mockResolvedValue(buildResponse());

    renderPropertiesPage();

    expect(await screen.findByText("Casa na praia")).toBeInTheDocument();
  });

  it("shows the empty state without the filters hint when there are no active filters", async () => {
    mockedListProperties.mockResolvedValue(
      buildResponse({ data: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0 } }),
    );

    renderPropertiesPage();

    expect(await screen.findByText("Nenhum imóvel encontrado.")).toBeInTheDocument();
    expect(screen.queryByText("Tente ajustar os filtros.")).not.toBeInTheDocument();
  });

  it("shows the filters hint on empty results when filters are active", async () => {
    mockedListProperties.mockResolvedValue(
      buildResponse({ data: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0 } }),
    );

    renderPropertiesPage(["/properties?city=Recife"]);

    expect(await screen.findByText("Tente ajustar os filtros.")).toBeInTheDocument();
  });

  it("shows an error state and retries", async () => {
    mockedListProperties.mockRejectedValue(new Error("boom"));

    renderPropertiesPage();

    expect(await screen.findByText("Não foi possível carregar os imóveis.")).toBeInTheDocument();

    mockedListProperties.mockResolvedValue(buildResponse());
    screen.getByRole("button", { name: "Tentar novamente" }).click();

    expect(await screen.findByText("Casa na praia")).toBeInTheDocument();
  });

  it("never calls listProperties more than once per render for the same filters (no N+1)", async () => {
    mockedListProperties.mockResolvedValue(buildResponse());

    renderPropertiesPage();

    await screen.findByText("Casa na praia");
    expect(mockedListProperties).toHaveBeenCalledTimes(1);
  });

  it("applies filters from the form, updates the URL, and resets the page", async () => {
    mockedListProperties.mockResolvedValue(buildResponse());

    renderPropertiesPage(["/properties?page=2"]);
    await screen.findByText("Casa na praia");

    const cityInput = screen.getByLabelText("Cidade");
    fireEvent.change(cityInput, { target: { value: "Recife" } });
    screen.getByRole("button", { name: "Aplicar filtros" }).click();

    await waitFor(() => {
      const lastCall = mockedListProperties.mock.calls.at(-1);
      expect(lastCall?.[1]).toMatchObject({ city: "Recife" });
      expect(lastCall?.[1].page).toBeUndefined();
    });
  });

  it("clears filters back to defaults", async () => {
    mockedListProperties.mockResolvedValue(buildResponse());

    renderPropertiesPage(["/properties?city=Recife&page=2"]);
    await screen.findByText("Casa na praia");
    expect(screen.getByLabelText("Cidade")).toHaveValue("Recife");

    screen.getByRole("button", { name: "Limpar filtros" }).click();

    await waitFor(() => {
      const lastCall = mockedListProperties.mock.calls.at(-1);
      expect(lastCall?.[1]).toEqual({});
    });
    await waitFor(() => expect(screen.getByLabelText("Cidade")).toHaveValue(""));
  });

  it("keeps the filter form synced with the URL when it changes externally", async () => {
    mockedListProperties.mockResolvedValue(buildResponse());

    const { router } = renderPropertiesPage(["/properties?city=Recife"]);
    await waitFor(() => expect(screen.getByLabelText("Cidade")).toHaveValue("Recife"));

    await act(async () => {
      await router.navigate("/properties?city=Salvador");
    });

    await waitFor(() => expect(screen.getByLabelText("Cidade")).toHaveValue("Salvador"));
  });

  it("paginates via next/previous while preserving filters", async () => {
    mockedListProperties.mockResolvedValue(
      buildResponse({ pagination: { page: 1, limit: 20, total: 40, total_pages: 2 } }),
    );

    renderPropertiesPage(["/properties?city=Recife"]);
    await screen.findByText("Casa na praia");

    expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();

    mockedListProperties.mockResolvedValue(
      buildResponse({ pagination: { page: 2, limit: 20, total: 40, total_pages: 2 } }),
    );
    screen.getByRole("button", { name: "Próxima" }).click();

    await waitFor(() => {
      const lastCall = mockedListProperties.mock.calls.at(-1);
      expect(lastCall?.[1]).toMatchObject({ city: "Recife", page: 2 });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Próxima" })).toBeDisabled());

    mockedListProperties.mockResolvedValue(
      buildResponse({ pagination: { page: 1, limit: 20, total: 40, total_pages: 2 } }),
    );
    screen.getByRole("button", { name: "Anterior" }).click();

    await waitFor(() => {
      const lastCall = mockedListProperties.mock.calls.at(-1);
      expect(lastCall?.[1]).toMatchObject({ city: "Recife" });
      expect(lastCall?.[1].page).toBeUndefined();
    });
  });

  it("changes sorting via the select, updating sort/order and resetting the page", async () => {
    mockedListProperties.mockResolvedValue(buildResponse());

    renderPropertiesPage(["/properties?page=2"]);
    await screen.findByText("Casa na praia");

    const trigger = screen.getByRole("combobox", { name: "Ordenar por" });
    trigger.click();

    const option = await screen.findByRole("option", { name: "Maior preço" });
    option.click();

    await waitFor(() => {
      const lastCall = mockedListProperties.mock.calls.at(-1);
      expect(lastCall?.[1]).toMatchObject({ sort: "price", order: "desc" });
      expect(lastCall?.[1].page).toBeUndefined();
    });
  });
});
