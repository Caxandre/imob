import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { routes } from "@/app/router/router";
import { createProperty } from "@/features/properties/api/create-property";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: undefined },
  requireTenantId: () => {
    throw new Error("VITE_TENANT_ID is not configured");
  },
}));

vi.mock("@/features/properties/api/create-property", () => ({
  createProperty: vi.fn(),
}));

const mockedCreateProperty = vi.mocked(createProperty);

describe("NewPropertyPage without a configured tenant", () => {
  it("shows a dedicated state and never calls createProperty (section 56)", () => {
    renderWithProviders(routes, { initialEntries: ["/properties/new"] });

    expect(screen.getByText("Tenant de desenvolvimento não configurado.")).toBeInTheDocument();
    expect(mockedCreateProperty).not.toHaveBeenCalled();
  });
});
