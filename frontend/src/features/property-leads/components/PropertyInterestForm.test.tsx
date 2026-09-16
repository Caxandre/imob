import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/http/api-error";

import { capturePropertyLead } from "../api/capture-property-lead";
import { PropertyInterestForm } from "./PropertyInterestForm";

vi.mock("../api/capture-property-lead", () => ({ capturePropertyLead: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedCapturePropertyLead = vi.mocked(capturePropertyLead);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function renderForm(status: "DRAFT" | "ACTIVE" | "INACTIVE" = "ACTIVE") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PropertyInterestForm tenantId={TENANT_ID} propertyId={PROPERTY_ID} status={status} />
    </QueryClientProvider>,
  );
}

function fillNameAndEmail() {
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Maria Souza" } });
  fireEvent.change(screen.getByLabelText("E-mail"), {
    target: { value: "maria@example.com" },
  });
}

beforeEach(() => {
  mockedCapturePropertyLead.mockReset();
});

describe("PropertyInterestForm — availability", () => {
  it("renders the form for an ACTIVE property", () => {
    renderForm("ACTIVE");

    expect(screen.getByLabelText("Nome")).toBeInTheDocument();
    expect(screen.getByLabelText("E-mail")).toBeInTheDocument();
    expect(screen.getByLabelText("Telefone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar interesse" })).toBeInTheDocument();
  });

  it("does not render inputs for a DRAFT property", () => {
    renderForm("DRAFT");

    expect(screen.queryByLabelText("Nome")).not.toBeInTheDocument();
    expect(
      screen.getByText("Este imóvel não está disponível para novos contatos."),
    ).toBeInTheDocument();
  });

  it("does not render inputs for an INACTIVE property", () => {
    renderForm("INACTIVE");

    expect(screen.queryByLabelText("Nome")).not.toBeInTheDocument();
    expect(
      screen.getByText("Este imóvel não está disponível para novos contatos."),
    ).toBeInTheDocument();
  });
});

describe("PropertyInterestForm — contact invariant", () => {
  it("blocks submit locally when neither email nor phone is filled", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Maria Souza" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar interesse" }));

    expect(await screen.findByText("Informe pelo menos um e-mail ou telefone.")).toBeInTheDocument();
    expect(mockedCapturePropertyLead).not.toHaveBeenCalled();
  });
});

describe("PropertyInterestForm — submit", () => {
  it("sends only name/email/phone/message on submit", async () => {
    mockedCapturePropertyLead.mockResolvedValue({ id: "lead-1" });

    renderForm();
    fillNameAndEmail();
    fireEvent.click(screen.getByRole("button", { name: "Enviar interesse" }));

    await waitFor(() => {
      expect(mockedCapturePropertyLead).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID, {
        name: "Maria Souza",
        email: "maria@example.com",
        phone: null,
        message: null,
      });
    });
  });

  it("shows a pending label and disables the button while submitting", async () => {
    mockedCapturePropertyLead.mockReturnValue(new Promise(() => {}));

    renderForm();
    fillNameAndEmail();
    fireEvent.click(screen.getByRole("button", { name: "Enviar interesse" }));

    expect(await screen.findByRole("button", { name: "Enviando..." })).toBeDisabled();
  });

  it("never fires a second request while one is pending (double-submit protection)", async () => {
    mockedCapturePropertyLead.mockReturnValue(new Promise(() => {}));

    renderForm();
    fillNameAndEmail();
    const button = screen.getByRole("button", { name: "Enviar interesse" });
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Enviando..." });
    fireEvent.click(screen.getByRole("button", { name: "Enviando..." }));

    expect(mockedCapturePropertyLead).toHaveBeenCalledTimes(1);
  });

  it("shows a success state after 201 and does not navigate away", async () => {
    mockedCapturePropertyLead.mockResolvedValue({ id: "lead-1" });

    renderForm();
    fillNameAndEmail();
    fireEvent.click(screen.getByRole("button", { name: "Enviar interesse" }));

    expect(await screen.findByText("Interesse enviado com sucesso.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Recebemos seu interesse. A equipe responsável poderá entrar em contato pelos dados informados.",
      ),
    ).toBeInTheDocument();
    // The form itself is gone — no way to trigger a second submit from the success state.
    expect(screen.queryByLabelText("Nome")).not.toBeInTheDocument();
  });
});

describe("PropertyInterestForm — error handling", () => {
  it("shows a contextual message for 400", async () => {
    mockedCapturePropertyLead.mockRejectedValue(new ApiError(400, "Bad Request"));

    renderForm();
    fillNameAndEmail();
    fireEvent.click(screen.getByRole("button", { name: "Enviar interesse" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Verifique os dados informados.");
  });

  it("shows the unavailable-property message for 404", async () => {
    mockedCapturePropertyLead.mockRejectedValue(new ApiError(404, "Not Found"));

    renderForm();
    fillNameAndEmail();
    fireEvent.click(screen.getByRole("button", { name: "Enviar interesse" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Este imóvel não está disponível para receber novos contatos.",
    );
  });

  it("shows the rate-limit message for 429", async () => {
    mockedCapturePropertyLead.mockRejectedValue(new ApiError(429, "Too Many Requests"));

    renderForm();
    fillNameAndEmail();
    fireEvent.click(screen.getByRole("button", { name: "Enviar interesse" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Muitas tentativas em pouco tempo. Aguarde um momento e tente novamente.",
    );
  });

  it("shows a safe message for 503 with no infra details", async () => {
    mockedCapturePropertyLead.mockRejectedValue(new ApiError(503, "Service Unavailable"));

    renderForm();
    fillNameAndEmail();
    fireEvent.click(screen.getByRole("button", { name: "Enviar interesse" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível enviar seu interesse agora. Tente novamente mais tarde.",
    );
  });

  it("shows a generic message for an unmapped error", async () => {
    mockedCapturePropertyLead.mockRejectedValue(new Error("boom"));

    renderForm();
    fillNameAndEmail();
    fireEvent.click(screen.getByRole("button", { name: "Enviar interesse" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível enviar seu interesse.",
    );
  });
});
