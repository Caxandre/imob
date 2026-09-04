import { createBrowserRouter, type RouteObject } from "react-router";

import { HomePage } from "@/pages/HomePage";
import { NotFoundPage } from "@/pages/NotFoundPage";

import { RootErrorBoundary } from "./RootErrorBoundary";

/**
 * Centralized route table (this task, section 19/20) — exported separately from `router` so
 * tests can feed the exact same route objects into `createMemoryRouter` (`src/test/render.tsx`)
 * instead of redeclaring routes. Only `/` and the `*` catch-all exist in this foundation —
 * every future feature adds its own route here, never a parallel routing mechanism.
 */
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <HomePage />,
    errorElement: <RootErrorBoundary />,
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
];

export const router = createBrowserRouter(routes);
