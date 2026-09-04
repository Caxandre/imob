import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";

/**
 * Test-only helper (this task, section 50 — created because at least one test, the router test,
 * genuinely needs it). Wraps a route table in the same provider stack `App.tsx` composes
 * (`QueryClientProvider` + a router), but with `createMemoryRouter` instead of
 * `createBrowserRouter` so tests control the initial URL directly, and a fresh `QueryClient`
 * with retries disabled per render (never shared across tests, never retrying in a test run).
 */
export function renderWithProviders(
  routes: RouteObject[],
  options?: { initialEntries?: string[] },
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(routes, { initialEntries: options?.initialEntries ?? ["/"] });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
