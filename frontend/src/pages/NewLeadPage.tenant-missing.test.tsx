import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { routes } from "@/app/router/router";
import { createLead } from "@/features/leads/api/create-lead";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: undefined },
  requireTenantId: () => {
    throw new Error("VITE_TENANT_ID is not configured");
  },
}));

vi.mock("@/features/leads/api/create-lead", () => ({
  createLead: vi.fn(),
}));

const mockedCreateLead = vi.mocked(createLead);

describe("NewLeadPage without a configured tenant", () => {
  it("shows a dedicated state and never calls createLead", () => {
    renderWithProviders(routes, { initialEntries: ["/leads/new"] });

    expect(screen.getByText("Tenant de desenvolvimento não configurado.")).toBeInTheDocument();
    expect(mockedCreateLead).not.toHaveBeenCalled();
  });
});
