import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routes } from "@/app/router/router";
import { ApiError } from "@/lib/http/api-error";

import { getLeadById } from "@/features/leads/api/get-lead";
import type { LeadWithProperty } from "@/features/leads/schemas/lead.schema";

const LEAD_ID = "7c2e5a1b-4d6f-4a8c-b3e7-1f9a2d5c8e40";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: "11111111-1111-1111-1111-111111111111" },
  requireTenantId: () => "11111111-1111-1111-1111-111111111111",
}));

vi.mock("@/features/leads/api/get-lead", () => ({
  getLeadById: vi.fn(),
}));

const mockedGetLeadById = vi.mocked(getLeadById);

function buildLead(overrides: Partial<LeadWithProperty> = {}): LeadWithProperty {
  return {
    id: LEAD_ID,
    property_id: null,
    name: "Maria Souza",
    email: "maria@example.com",
    phone: "11999990000",
    status: "NEW",
    source: "WEBSITE",
    message: "Tenho interesse neste apartamento.",
    notes: "Ligar de manhã.",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    property: null,
    ...overrides,
  };
}

function renderPage(path = `/leads/${LEAD_ID}`) {
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
  mockedGetLeadById.mockReset();
});

describe("LeadDetailsPage", () => {
  it("shows a skeleton before the lead resolves", () => {
    mockedGetLeadById.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.queryByText("Maria Souza")).not.toBeInTheDocument();
  });

  it("renders the lead's fields once loaded", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead());

    renderPage();

    expect(await screen.findByText("Maria Souza")).toBeInTheDocument();
    expect(screen.getByText("Novo")).toBeInTheDocument();
    expect(screen.getByText("Site")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "maria@example.com" })).toHaveAttribute(
      "href",
      "mailto:maria@example.com",
    );
    expect(screen.getByRole("link", { name: "11999990000" })).toHaveAttribute(
      "href",
      "tel:11999990000",
    );
    expect(screen.getByText("Tenho interesse neste apartamento.")).toBeInTheDocument();
    expect(screen.getByText("Ligar de manhã.")).toBeInTheDocument();
  });

  it("renders the property summary with a link and never fetches Property separately", async () => {
    mockedGetLeadById.mockResolvedValue(
      buildLead({
        property_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        property: {
          id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          title: "Apartamento no Centro",
          status: "ACTIVE",
        },
      }),
    );

    renderPage();

    await screen.findByText("Maria Souza");
    const propertyLink = screen.getByRole("link", { name: "Apartamento no Centro" });
    expect(propertyLink).toHaveAttribute("href", "/properties/3fa85f64-5717-4562-b3fc-2c963f66afa6");
    expect(mockedGetLeadById).toHaveBeenCalledTimes(1);
  });

  it("renders no property block when the lead has no association", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead({ property: null }));

    renderPage();

    await screen.findByText("Maria Souza");
    expect(screen.queryByText("Imóvel associado")).not.toBeInTheDocument();
  });

  it("mailto/tel links only render when the value exists", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead({ phone: null }));

    renderPage();

    await screen.findByText("Maria Souza");
    expect(screen.queryByRole("link", { name: /^tel:/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "maria@example.com" })).toBeInTheDocument();
  });

  it("shows a not-found state on a 404, without rendering the lead", async () => {
    mockedGetLeadById.mockRejectedValue(new ApiError(404, "Lead not found"));

    renderPage();

    expect(await screen.findByText("Lead não encontrado.")).toBeInTheDocument();
    expect(screen.queryByText("Maria Souza")).not.toBeInTheDocument();
  });

  it("shows a not-found state for an obviously-invalid id, without any request", async () => {
    renderPage("/leads/not-a-uuid");

    expect(await screen.findByText("Lead não encontrado.")).toBeInTheDocument();
    expect(mockedGetLeadById).not.toHaveBeenCalled();
  });

  it("shows a generic error state and retries on a non-404 load error", async () => {
    mockedGetLeadById.mockRejectedValue(new Error("boom"));

    renderPage();

    expect(await screen.findByText("Não foi possível carregar o lead.")).toBeInTheDocument();

    mockedGetLeadById.mockResolvedValue(buildLead());
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByText("Maria Souza")).toBeInTheDocument();
  });

  it("has an Editar link to the edit page and no delete action", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead());

    renderPage();

    await screen.findByText("Maria Souza");
    expect(screen.getByRole("link", { name: "Editar" })).toHaveAttribute(
      "href",
      `/leads/${LEAD_ID}/edit`,
    );
    expect(screen.queryByRole("button", { name: /excluir/i })).not.toBeInTheDocument();
  });
});
