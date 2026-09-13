import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routes } from "@/app/router/router";
import { listLeads } from "@/features/leads/api/list-leads";
import type { LeadListResponse } from "@/features/leads/schemas/lead.schema";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: "11111111-1111-1111-1111-111111111111" },
  requireTenantId: () => "11111111-1111-1111-1111-111111111111",
}));

vi.mock("@/features/leads/api/list-leads", () => ({
  listLeads: vi.fn(),
}));

const mockedListLeads = vi.mocked(listLeads);

function buildResponse(overrides: Partial<LeadListResponse> = {}): LeadListResponse {
  return {
    data: [
      {
        id: "l1",
        property_id: null,
        name: "Maria Souza",
        email: "maria@example.com",
        phone: "11999990000",
        status: "NEW",
        source: "MANUAL",
        message: "Tenho interesse.",
        notes: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        property: null,
      },
    ],
    pagination: { page: 1, limit: 20, total: 1, total_pages: 1 },
    ...overrides,
  };
}

function renderLeadsPage(initialEntries: string[] = ["/leads"]) {
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
  mockedListLeads.mockReset();
});

describe("LeadsPage", () => {
  it("shows a loading skeleton before data resolves", () => {
    mockedListLeads.mockReturnValue(new Promise(() => {}));

    renderLeadsPage();

    expect(screen.getByText("Leads")).toBeInTheDocument();
    expect(screen.queryByText("Maria Souza")).not.toBeInTheDocument();
  });

  it("renders lead rows on success", async () => {
    mockedListLeads.mockResolvedValue(buildResponse());

    renderLeadsPage();

    expect(await screen.findByText("Maria Souza")).toBeInTheDocument();
    expect(screen.getByText("maria@example.com")).toBeInTheDocument();
  });

  it("shows the empty state without the filters hint when there are no active filters", async () => {
    mockedListLeads.mockResolvedValue(
      buildResponse({ data: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0 } }),
    );

    renderLeadsPage();

    expect(await screen.findByText("Nenhum lead encontrado.")).toBeInTheDocument();
  });

  it("shows the filters hint on empty results when filters are active", async () => {
    mockedListLeads.mockResolvedValue(
      buildResponse({ data: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0 } }),
    );

    renderLeadsPage(["/leads?status=LOST"]);

    expect(await screen.findByText("Nenhum lead corresponde aos filtros.")).toBeInTheDocument();
  });

  it("shows an error state and retries", async () => {
    mockedListLeads.mockRejectedValue(new Error("boom"));

    renderLeadsPage();

    expect(await screen.findByText("Não foi possível carregar os leads.")).toBeInTheDocument();

    mockedListLeads.mockResolvedValue(buildResponse());
    screen.getByRole("button", { name: "Tentar novamente" }).click();

    expect(await screen.findByText("Maria Souza")).toBeInTheDocument();
  });

  it("never calls listLeads more than once per render for the same filters (no N+1)", async () => {
    mockedListLeads.mockResolvedValue(buildResponse());

    renderLeadsPage();

    await screen.findByText("Maria Souza");
    expect(mockedListLeads).toHaveBeenCalledTimes(1);
  });

  it("applies filters from the form, updates the URL, and resets the page", async () => {
    mockedListLeads.mockResolvedValue(buildResponse());

    renderLeadsPage(["/leads?page=2"]);
    await screen.findByText("Maria Souza");

    const qInput = screen.getByLabelText("Buscar por nome, email ou telefone");
    fireEvent.change(qInput, { target: { value: "maria" } });
    screen.getByRole("button", { name: "Aplicar filtros" }).click();

    await waitFor(() => {
      const lastCall = mockedListLeads.mock.calls.at(-1);
      expect(lastCall?.[1]).toMatchObject({ q: "maria" });
      expect(lastCall?.[1].page).toBeUndefined();
    });
  });

  it("clears filters back to defaults", async () => {
    mockedListLeads.mockResolvedValue(buildResponse());

    renderLeadsPage(["/leads?q=maria&page=2"]);
    await screen.findByText("Maria Souza");
    expect(screen.getByLabelText("Buscar por nome, email ou telefone")).toHaveValue("maria");

    screen.getByRole("button", { name: "Limpar filtros" }).click();

    await waitFor(() => {
      const lastCall = mockedListLeads.mock.calls.at(-1);
      expect(lastCall?.[1]).toEqual({});
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Buscar por nome, email ou telefone")).toHaveValue(""),
    );
  });

  it("keeps the filter form synced with the URL when it changes externally", async () => {
    mockedListLeads.mockResolvedValue(buildResponse());

    const { router } = renderLeadsPage(["/leads?q=maria"]);
    await waitFor(() =>
      expect(screen.getByLabelText("Buscar por nome, email ou telefone")).toHaveValue("maria"),
    );

    await act(async () => {
      await router.navigate("/leads?q=joao");
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Buscar por nome, email ou telefone")).toHaveValue("joao"),
    );
  });

  it("paginates via next/previous while preserving filters", async () => {
    mockedListLeads.mockResolvedValue(
      buildResponse({ pagination: { page: 1, limit: 20, total: 40, total_pages: 2 } }),
    );

    renderLeadsPage(["/leads?status=NEW"]);
    await screen.findByText("Maria Souza");

    expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();

    mockedListLeads.mockResolvedValue(
      buildResponse({ pagination: { page: 2, limit: 20, total: 40, total_pages: 2 } }),
    );
    screen.getByRole("button", { name: "Próxima" }).click();

    await waitFor(() => {
      const lastCall = mockedListLeads.mock.calls.at(-1);
      expect(lastCall?.[1]).toMatchObject({ status: "NEW", page: 2 });
    });
  });

  it("renders status/source badges and the property link when associated", async () => {
    mockedListLeads.mockResolvedValue(
      buildResponse({
        data: [
          {
            id: "l1",
            property_id: "p1",
            name: "Com Imóvel",
            email: null,
            phone: "11988887777",
            status: "QUALIFIED",
            source: "PORTAL",
            message: null,
            notes: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            property: { id: "p1", title: "Casa na Praia", status: "ACTIVE" },
          },
        ],
      }),
    );

    renderLeadsPage();

    // Waits on the lead's own name — "Qualificado"/"Portal" also exist as static <select>
    // options in the filter form, so asserting on those first could pass before the query
    // actually resolves.
    await screen.findByText("Com Imóvel");
    const propertyLink = screen.getByRole("link", { name: "Casa na Praia" });
    expect(propertyLink).toHaveAttribute("href", "/properties/p1");
  });

  it("never renders notes/message in the list (only detail-worthy fields)", async () => {
    mockedListLeads.mockResolvedValue(
      buildResponse({
        data: [
          {
            id: "l1",
            property_id: null,
            name: "Maria Souza",
            email: "maria@example.com",
            phone: null,
            status: "NEW",
            source: "MANUAL",
            message: "Mensagem original secreta.",
            notes: "Observação interna secreta.",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            property: null,
          },
        ],
      }),
    );

    renderLeadsPage();

    await screen.findByText("Maria Souza");
    expect(screen.queryByText("Mensagem original secreta.")).not.toBeInTheDocument();
    expect(screen.queryByText("Observação interna secreta.")).not.toBeInTheDocument();
  });
});
