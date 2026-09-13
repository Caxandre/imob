import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { routes } from "@/app/router/router";
import { getLeadById } from "@/features/leads/api/get-lead";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: undefined },
  requireTenantId: () => {
    throw new Error("VITE_TENANT_ID is not configured");
  },
}));

vi.mock("@/features/leads/api/get-lead", () => ({
  getLeadById: vi.fn(),
}));

const mockedGetLeadById = vi.mocked(getLeadById);

describe("EditLeadPage without a configured tenant", () => {
  it("shows a dedicated state and never calls getLeadById", () => {
    renderWithProviders(routes, {
      initialEntries: ["/leads/7c2e5a1b-4d6f-4a8c-b3e7-1f9a2d5c8e40/edit"],
    });

    expect(screen.getByText("Tenant de desenvolvimento não configurado.")).toBeInTheDocument();
    expect(mockedGetLeadById).not.toHaveBeenCalled();
  });
});
