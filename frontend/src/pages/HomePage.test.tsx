import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { HomePage } from "./HomePage";

describe("HomePage", () => {
  it("renders the app name and the foundation-ready message", () => {
    renderWithProviders([{ path: "/", element: <HomePage /> }]);

    expect(screen.getByText("Imob")).toBeInTheDocument();
    expect(screen.getByText("Frontend foundation is ready.")).toBeInTheDocument();
  });
});
