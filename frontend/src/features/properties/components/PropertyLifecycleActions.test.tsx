import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { archiveProperty } from "../api/archive-property";
import { updateProperty } from "../api/update-property";
import type { PropertyStatus } from "../schemas/property.schema";
import { PropertyLifecycleActions } from "./PropertyLifecycleActions";

vi.mock("../api/update-property", () => ({ updateProperty: vi.fn() }));
vi.mock("../api/archive-property", () => ({ archiveProperty: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedUpdateProperty = vi.mocked(updateProperty);
const mockedArchiveProperty = vi.mocked(archiveProperty);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function renderActions(status: PropertyStatus) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PropertyLifecycleActions tenantId={TENANT_ID} propertyId={PROPERTY_ID} status={status} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedUpdateProperty.mockReset();
  mockedArchiveProperty.mockReset();
});

describe("PropertyLifecycleActions — DRAFT", () => {
  it("shows only 'Ativar imóvel'", () => {
    renderActions("DRAFT");

    expect(screen.getByRole("button", { name: "Ativar imóvel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Arquivar imóvel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reativar imóvel" })).not.toBeInTheDocument();
  });

  it("activates via PATCH { status: 'ACTIVE' } with no confirmation", async () => {
    mockedUpdateProperty.mockResolvedValue({} as never);

    renderActions("DRAFT");
    fireEvent.click(screen.getByRole("button", { name: "Ativar imóvel" }));

    await waitFor(() => {
      expect(mockedUpdateProperty).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID, { status: "ACTIVE" });
    });
    expect(mockedArchiveProperty).not.toHaveBeenCalled();
  });

  it("shows a pending label and disables the button while activating", async () => {
    mockedUpdateProperty.mockReturnValue(new Promise(() => {}));

    renderActions("DRAFT");
    fireEvent.click(screen.getByRole("button", { name: "Ativar imóvel" }));

    expect(await screen.findByRole("button", { name: "Ativando..." })).toBeDisabled();
    // A second click while pending must never fire a second request.
    fireEvent.click(screen.getByRole("button", { name: "Ativando..." }));
    expect(mockedUpdateProperty).toHaveBeenCalledTimes(1);
  });

  it("shows a safe error message when activation fails", async () => {
    mockedUpdateProperty.mockRejectedValue(new Error("boom"));

    renderActions("DRAFT");
    fireEvent.click(screen.getByRole("button", { name: "Ativar imóvel" }));

    expect(await screen.findByText("Não foi possível ativar o imóvel.")).toBeInTheDocument();
    // No optimistic change: the DRAFT action is still the one shown.
    expect(screen.getByRole("button", { name: "Ativar imóvel" })).toBeInTheDocument();
  });
});

describe("PropertyLifecycleActions — ACTIVE", () => {
  it("shows only 'Arquivar imóvel'", () => {
    renderActions("ACTIVE");

    expect(screen.getByRole("button", { name: "Arquivar imóvel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ativar imóvel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reativar imóvel" })).not.toBeInTheDocument();
  });

  it("requires confirmation before archiving", async () => {
    renderActions("ACTIVE");
    fireEvent.click(screen.getByRole("button", { name: "Arquivar imóvel" }));

    expect(await screen.findByText("Arquivar imóvel?")).toBeInTheDocument();
    expect(
      screen.getByText("O imóvel ficará inativo e poderá ser reativado posteriormente."),
    ).toBeInTheDocument();
    expect(mockedArchiveProperty).not.toHaveBeenCalled();
  });

  it("cancelling the confirmation never calls the API", async () => {
    renderActions("ACTIVE");
    fireEvent.click(screen.getByRole("button", { name: "Arquivar imóvel" }));
    await screen.findByText("Arquivar imóvel?");

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByText("Arquivar imóvel?")).not.toBeInTheDocument());
    expect(mockedArchiveProperty).not.toHaveBeenCalled();
  });

  it("confirming calls DELETE via archiveProperty, never PATCH", async () => {
    mockedArchiveProperty.mockResolvedValue(undefined);

    renderActions("ACTIVE");
    fireEvent.click(screen.getByRole("button", { name: "Arquivar imóvel" }));
    await screen.findByText("Arquivar imóvel?");

    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));

    await waitFor(() => {
      expect(mockedArchiveProperty).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID);
    });
    expect(mockedUpdateProperty).not.toHaveBeenCalled();
  });

  it("shows a safe error message when archiving fails", async () => {
    mockedArchiveProperty.mockRejectedValue(new Error("boom"));

    renderActions("ACTIVE");
    fireEvent.click(screen.getByRole("button", { name: "Arquivar imóvel" }));
    await screen.findByText("Arquivar imóvel?");
    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));

    expect(await screen.findByText("Não foi possível arquivar o imóvel.")).toBeInTheDocument();
    // No optimistic change: the ACTIVE action is still the one shown.
    expect(screen.getByRole("button", { name: "Arquivar imóvel" })).toBeInTheDocument();
  });
});

describe("PropertyLifecycleActions — INACTIVE", () => {
  it("shows only 'Reativar imóvel'", () => {
    renderActions("INACTIVE");

    expect(screen.getByRole("button", { name: "Reativar imóvel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ativar imóvel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Arquivar imóvel" })).not.toBeInTheDocument();
  });

  it("reactivates via PATCH { status: 'ACTIVE' } with no confirmation", async () => {
    mockedUpdateProperty.mockResolvedValue({} as never);

    renderActions("INACTIVE");
    fireEvent.click(screen.getByRole("button", { name: "Reativar imóvel" }));

    await waitFor(() => {
      expect(mockedUpdateProperty).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID, { status: "ACTIVE" });
    });
    expect(mockedArchiveProperty).not.toHaveBeenCalled();
  });

  it("shows a pending label while reactivating", async () => {
    mockedUpdateProperty.mockReturnValue(new Promise(() => {}));

    renderActions("INACTIVE");
    fireEvent.click(screen.getByRole("button", { name: "Reativar imóvel" }));

    expect(await screen.findByRole("button", { name: "Reativando..." })).toBeDisabled();
  });

  it("shows a safe error message when reactivation fails", async () => {
    mockedUpdateProperty.mockRejectedValue(new Error("boom"));

    renderActions("INACTIVE");
    fireEvent.click(screen.getByRole("button", { name: "Reativar imóvel" }));

    expect(await screen.findByText("Não foi possível reativar o imóvel.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reativar imóvel" })).toBeInTheDocument();
  });
});
