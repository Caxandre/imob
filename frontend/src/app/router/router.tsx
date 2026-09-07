import { createBrowserRouter, type RouteObject } from "react-router";

import { HomePage } from "@/pages/HomePage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { PropertiesPage } from "@/pages/PropertiesPage";

import { RootErrorBoundary } from "./RootErrorBoundary";

/**
 * Centralized route table (this task, section 19/20; Prompt 037B section 7 adds `/properties`)
 * — exported separately from `router` so tests can feed the exact same route objects into
 * `createMemoryRouter` (`src/test/render.tsx`) instead of redeclaring routes.
 */
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <HomePage />,
    errorElement: <RootErrorBoundary />,
  },
  {
    path: "/properties",
    element: <PropertiesPage />,
    errorElement: <RootErrorBoundary />,
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
];

export const router = createBrowserRouter(routes);
