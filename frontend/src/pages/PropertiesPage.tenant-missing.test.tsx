import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { routes } from "@/app/router/router";
import { listProperties } from "@/features/properties/api/list-properties";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: undefined },
  requireTenantId: () => {
    throw new Error("VITE_TENANT_ID is not configured");
  },
}));

vi.mock("@/features/properties/api/list-properties", () => ({
  listProperties: vi.fn(),
}));

const mockedListProperties = vi.mocked(listProperties);

describe("PropertiesPage without a configured tenant", () => {
  it("shows a dedicated state and never calls listProperties (section 61/96)", () => {
    renderWithProviders(routes, { initialEntries: ["/properties"] });

    expect(screen.getByText("Tenant de desenvolvimento não configurado.")).toBeInTheDocument();
    expect(mockedListProperties).not.toHaveBeenCalled();
  });

  it("never renders the tenant id anywhere on the page", () => {
    renderWithProviders(routes, { initialEntries: ["/properties"] });

    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it("still renders the Home page without a configured tenant", () => {
    renderWithProviders(routes, { initialEntries: ["/"] });

    expect(screen.getByText("Imob")).toBeInTheDocument();
  });
});
