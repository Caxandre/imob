import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { routes } from "@/app/router/router";
import { getPropertyById } from "@/features/properties/api/get-property";
import { listPropertyMedia } from "@/features/properties/api/list-property-media";

vi.mock("@/lib/env", () => ({
  env: { apiUrl: "http://localhost:3000", tenantId: undefined },
  requireTenantId: () => {
    throw new Error("VITE_TENANT_ID is not configured");
  },
}));

vi.mock("@/features/properties/api/get-property", () => ({
  getPropertyById: vi.fn(),
}));

vi.mock("@/features/properties/api/list-property-media", () => ({
  listPropertyMedia: vi.fn(),
}));

const mockedGetPropertyById = vi.mocked(getPropertyById);
const mockedListPropertyMedia = vi.mocked(listPropertyMedia);

describe("PropertyDetailsPage without a configured tenant", () => {
  it("shows a dedicated state and never calls getPropertyById/listPropertyMedia (section 48)", () => {
    renderWithProviders(routes, {
      initialEntries: ["/properties/3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    });

    expect(screen.getByText("Tenant de desenvolvimento não configurado.")).toBeInTheDocument();
    expect(mockedGetPropertyById).not.toHaveBeenCalled();
    expect(mockedListPropertyMedia).not.toHaveBeenCalled();
  });
});
