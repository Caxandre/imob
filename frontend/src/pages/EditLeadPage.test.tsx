import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routes } from "@/app/router/router";
import { ApiError } from "@/lib/http/api-error";

import { getLeadById } from "@/features/leads/api/get-lead";
import { listPropertyOptions } from "@/features/leads/api/list-property-options";
import { updateLead } from "@/features/leads/api/update-lead";
import type { LeadWithProperty } from "@/features/leads/schemas/lead.schema";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const LEAD_ID = "7c2e5a1b-4d6f-4a8c-b3e7-1f9a2d5c8e40";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: "11111111-1111-1111-1111-111111111111" },
  requireTenantId: () => "11111111-1111-1111-1111-111111111111",
}));

vi.mock("@/features/leads/api/get-lead", () => ({
  getLeadById: vi.fn(),
}));

vi.mock("@/features/leads/api/update-lead", () => ({
  updateLead: vi.fn(),
}));

vi.mock("@/features/leads/api/list-property-options", () => ({
  listPropertyOptions: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockedGetLeadById = vi.mocked(getLeadById);
const mockedUpdateLead = vi.mocked(updateLead);
const mockedListPropertyOptions = vi.mocked(listPropertyOptions);

function buildLead(overrides: Partial<LeadWithProperty> = {}): LeadWithProperty {
  return {
    id: LEAD_ID,
    property_id: null,
    name: "Maria Souza",
    email: "maria@example.com",
    phone: null,
    status: "NEW",
    source: "MANUAL",
    message: null,
    notes: "Nota original",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    property: null,
    ...overrides,
  };
}

function renderPage(path = `/leads/${LEAD_ID}/edit`) {
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
  mockedUpdateLead.mockReset();
  mockedListPropertyOptions.mockReset();
  mockedListPropertyOptions.mockResolvedValue({ options: [], truncated: false });
});

describe("EditLeadPage", () => {
  it("shows a skeleton before the lead resolves, without empty inputs", () => {
    mockedGetLeadById.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.queryByLabelText("Nome *")).not.toBeInTheDocument();
  });

  it("hydrates the form from the loaded lead, including the status field", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead({ status: "CONTACTED" }));

    renderPage();

    expect(await screen.findByLabelText("Nome *")).toHaveValue("Maria Souza");
    expect(screen.getByLabelText("E-mail")).toHaveValue("maria@example.com");
    expect(screen.getByLabelText("Observação")).toHaveValue("Nota original");
    expect(screen.getByLabelText("Status")).toBeInTheDocument();
  });

  it("shows a not-found state on a 404, without rendering the form", async () => {
    mockedGetLeadById.mockRejectedValue(new ApiError(404, "Lead not found"));

    renderPage();

    expect(await screen.findByText("Lead não encontrado.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nome *")).not.toBeInTheDocument();
  });

  it("shows a not-found state for an obviously-invalid id, without any request", async () => {
    renderPage("/leads/not-a-uuid/edit");

    expect(await screen.findByText("Lead não encontrado.")).toBeInTheDocument();
    expect(mockedGetLeadById).not.toHaveBeenCalled();
  });

  it("shows a generic error state and retries on a non-404 load error", async () => {
    mockedGetLeadById.mockRejectedValue(new Error("boom"));

    renderPage();

    expect(await screen.findByText("Não foi possível carregar o lead.")).toBeInTheDocument();

    mockedGetLeadById.mockResolvedValue(buildLead());
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByLabelText("Nome *")).toBeInTheDocument();
  });

  it("disables Save when nothing has changed", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead());

    renderPage();

    expect(await screen.findByRole("button", { name: "Salvar" })).toBeDisabled();
    expect(mockedUpdateLead).not.toHaveBeenCalled();
  });

  it("sends only the dirty field(s) — altering only status", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead());
    mockedUpdateLead.mockResolvedValue({ ...buildLead(), status: "CONTACTED" });

    const { router } = renderPage();
    await screen.findByLabelText("Nome *");

    const statusTrigger = screen.getByRole("combobox", { name: "Status" });
    fireEvent.click(statusTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "Contatado" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedUpdateLead).toHaveBeenCalledWith(TENANT_ID, LEAD_ID, { status: "CONTACTED" });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/leads/${LEAD_ID}`));
  });

  it("blocks submit client-side when clearing the only remaining contact channel", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead({ email: "maria@example.com", phone: null }));

    renderPage();
    await screen.findByLabelText("Nome *");

    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(
      await screen.findByText("Informe pelo menos um e-mail ou telefone."),
    ).toBeInTheDocument();
    expect(mockedUpdateLead).not.toHaveBeenCalled();
  });

  it("allows adding a phone while clearing email, sending both as dirty fields", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead({ email: "maria@example.com", phone: null }));
    mockedUpdateLead.mockResolvedValue(
      buildLead({ email: null, phone: "11988887777" }),
    );

    renderPage();
    await screen.findByLabelText("Nome *");

    fireEvent.change(screen.getByLabelText("Telefone"), { target: { value: "11988887777" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedUpdateLead).toHaveBeenCalledWith(TENANT_ID, LEAD_ID, {
        email: null,
        phone: "11988887777",
      });
    });
  });

  it("sends an explicit null when a dirty nullable text field is cleared", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead());
    mockedUpdateLead.mockResolvedValue(buildLead({ notes: null }));

    renderPage();
    await screen.findByLabelText("Nome *");

    fireEvent.change(screen.getByLabelText("Observação"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedUpdateLead).toHaveBeenCalledWith(TENANT_ID, LEAD_ID, { notes: null });
    });
  });

  it("sends property_id: null when the association is cleared", async () => {
    mockedGetLeadById.mockResolvedValue(
      buildLead({
        property_id: "p1",
        property: { id: "p1", title: "Casa na Praia", status: "ACTIVE" },
      }),
    );
    mockedUpdateLead.mockResolvedValue(buildLead({ property_id: null }));

    renderPage();
    await screen.findByLabelText("Nome *");
    // Waits for `usePropertyOptions` to settle (the select is disabled while pending).
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Imóvel (opcional)" })).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Imóvel (opcional)" }));
    fireEvent.click(await screen.findByRole("option", { name: "Nenhum imóvel" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedUpdateLead).toHaveBeenCalledWith(TENANT_ID, LEAD_ID, { property_id: null });
    });
  });

  it("still offers the currently-associated property as an option even if it's outside the fetched page", async () => {
    mockedListPropertyOptions.mockResolvedValue({ options: [], truncated: true });
    mockedGetLeadById.mockResolvedValue(
      buildLead({
        property_id: "p1",
        property: { id: "p1", title: "Casa Fora Da Página", status: "ACTIVE" },
      }),
    );

    renderPage();

    await screen.findByLabelText("Nome *");
    expect(screen.getByRole("combobox", { name: "Imóvel (opcional)" })).toHaveTextContent(
      "Casa Fora Da Página",
    );
  });

  it("shows a safe error message and stays on the page when the mutation fails", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead());
    mockedUpdateLead.mockRejectedValue(new Error("boom"));

    const { router } = renderPage();
    await screen.findByLabelText("Nome *");

    fireEvent.change(screen.getByLabelText("Observação"), { target: { value: "Nova nota" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Não foi possível salvar o lead.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/leads/${LEAD_ID}/edit`);
  });

  it("cancel navigates back to the lead's detail page", async () => {
    mockedGetLeadById.mockResolvedValue(buildLead());

    const { router } = renderPage();
    await screen.findByLabelText("Nome *");

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(router.state.location.pathname).toBe(`/leads/${LEAD_ID}`);
  });
});
