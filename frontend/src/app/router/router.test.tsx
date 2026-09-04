import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { routes } from "./router";

describe("routes", () => {
  it("renders the home page at /", () => {
    renderWithProviders(routes, { initialEntries: ["/"] });

    expect(screen.getByText("Imob")).toBeInTheDocument();
  });

  it("renders the 404 page for an unknown route", () => {
    renderWithProviders(routes, { initialEntries: ["/does-not-exist"] });

    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByText("Página não encontrada")).toBeInTheDocument();
  });
});
