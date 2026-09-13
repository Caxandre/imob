import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routes } from "@/app/router/router";
import { createLead } from "@/features/leads/api/create-lead";
import { listPropertyOptions } from "@/features/leads/api/list-property-options";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: "11111111-1111-1111-1111-111111111111" },
  requireTenantId: () => "11111111-1111-1111-1111-111111111111",
}));

vi.mock("@/features/leads/api/create-lead", () => ({
  createLead: vi.fn(),
}));

vi.mock("@/features/leads/api/list-property-options", () => ({
  listPropertyOptions: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockedCreateLead = vi.mocked(createLead);
const mockedListPropertyOptions = vi.mocked(listPropertyOptions);

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: ["/leads/new"] });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}

function fillName() {
  fireEvent.change(screen.getByLabelText("Nome *"), { target: { value: "Maria Souza" } });
}

beforeEach(() => {
  mockedCreateLead.mockReset();
  mockedListPropertyOptions.mockReset();
  mockedListPropertyOptions.mockResolvedValue({ options: [], truncated: false });
});

describe("NewLeadPage", () => {
  it("renders the empty form without a status field", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Novo lead" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nome *")).toHaveValue("");
    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
  });

  it("shows a validation error and never calls the API when name is missing", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Nome é obrigatório")).toBeInTheDocument();
    expect(mockedCreateLead).not.toHaveBeenCalled();
  });

  it("shows the contact-invariant error and never calls the API without email or phone", async () => {
    renderPage();

    fillName();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(
      await screen.findByText("Informe pelo menos um e-mail ou telefone."),
    ).toBeInTheDocument();
    expect(mockedCreateLead).not.toHaveBeenCalled();
  });

  it("submits with only email", async () => {
    mockedCreateLead.mockResolvedValue({
      id: "l1",
      property_id: null,
      name: "Maria Souza",
      email: "maria@example.com",
      phone: null,
      status: "NEW",
      source: "MANUAL",
      message: null,
      notes: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const { router } = renderPage();
    fillName();
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "maria@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedCreateLead).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({ name: "Maria Souza", email: "maria@example.com", phone: null }),
      );
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/leads/l1"));
  });

  it("submits with only phone", async () => {
    mockedCreateLead.mockResolvedValue({
      id: "l1",
      property_id: null,
      name: "Maria Souza",
      email: null,
      phone: "11999990000",
      status: "NEW",
      source: "MANUAL",
      message: null,
      notes: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    renderPage();
    fillName();
    fireEvent.change(screen.getByLabelText("Telefone"), { target: { value: "11999990000" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedCreateLead).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({ phone: "11999990000", email: null }),
      );
    });
  });

  it("never sends a status key in the create payload", async () => {
    mockedCreateLead.mockResolvedValue({
      id: "l1",
      property_id: null,
      name: "Maria Souza",
      email: "maria@example.com",
      phone: null,
      status: "NEW",
      source: "MANUAL",
      message: null,
      notes: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    renderPage();
    fillName();
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "maria@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(mockedCreateLead).toHaveBeenCalled());
    const [, input] = mockedCreateLead.mock.calls[0]!;
    expect(input).not.toHaveProperty("status");
  });

  it("submits with a selected property association", async () => {
    mockedListPropertyOptions.mockResolvedValue({
      options: [{ id: "p1", title: "Casa na Praia", status: "ACTIVE" }],
      truncated: false,
    });
    mockedCreateLead.mockResolvedValue({
      id: "l1",
      property_id: "p1",
      name: "Maria Souza",
      email: "maria@example.com",
      phone: null,
      status: "NEW",
      source: "MANUAL",
      message: null,
      notes: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    renderPage();
    fillName();
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "maria@example.com" } });
    await screen.findByText("Casa na Praia");

    fireEvent.click(screen.getByRole("combobox", { name: "Imóvel (opcional)" }));
    fireEvent.click(await screen.findByRole("option", { name: "Casa na Praia" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedCreateLead).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({ property_id: "p1" }),
      );
    });
  });

  it("includes message and notes when filled", async () => {
    mockedCreateLead.mockResolvedValue({
      id: "l1",
      property_id: null,
      name: "Maria Souza",
      email: "maria@example.com",
      phone: null,
      status: "NEW",
      source: "MANUAL",
      message: "Olá",
      notes: "Ligar amanhã",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    renderPage();
    fillName();
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "maria@example.com" } });
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "Olá" } });
    fireEvent.change(screen.getByLabelText("Observação"), { target: { value: "Ligar amanhã" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(mockedCreateLead).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({ message: "Olá", notes: "Ligar amanhã" }),
      );
    });
  });

  it("shows a safe error message and does not navigate when the mutation fails", async () => {
    mockedCreateLead.mockRejectedValue(new Error("boom"));

    const { router } = renderPage();
    fillName();
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "maria@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Não foi possível criar o lead.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/leads/new");
  });

  it("cancel navigates back to /leads", () => {
    const { router } = renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(router.state.location.pathname).toBe("/leads");
  });
});
