import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { routes } from "@/app/router/router";
import { listLeads } from "@/features/leads/api/list-leads";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: undefined },
  requireTenantId: () => {
    throw new Error("VITE_TENANT_ID is not configured");
  },
}));

vi.mock("@/features/leads/api/list-leads", () => ({
  listLeads: vi.fn(),
}));

const mockedListLeads = vi.mocked(listLeads);

describe("LeadsPage without a configured tenant", () => {
  it("shows a dedicated state and never calls listLeads", () => {
    renderWithProviders(routes, { initialEntries: ["/leads"] });

    expect(screen.getByText("Tenant de desenvolvimento não configurado.")).toBeInTheDocument();
    expect(mockedListLeads).not.toHaveBeenCalled();
  });

  it("never renders the tenant id anywhere on the page", () => {
    renderWithProviders(routes, { initialEntries: ["/leads"] });

    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
