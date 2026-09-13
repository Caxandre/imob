import { createBrowserRouter, type RouteObject } from "react-router";

import { EditLeadPage } from "@/pages/EditLeadPage";
import { EditPropertyPage } from "@/pages/EditPropertyPage";
import { HomePage } from "@/pages/HomePage";
import { LeadDetailsPage } from "@/pages/LeadDetailsPage";
import { LeadsPage } from "@/pages/LeadsPage";
import { NewLeadPage } from "@/pages/NewLeadPage";
import { NewPropertyPage } from "@/pages/NewPropertyPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { PropertiesPage } from "@/pages/PropertiesPage";
import { PropertyDetailsPage } from "@/pages/PropertyDetailsPage";

import { RootErrorBoundary } from "./RootErrorBoundary";

/**
 * Centralized route table (this task, section 19/20; Prompt 037B section 7 adds `/properties`;
 * Prompt 038 adds `/properties/:id`; Prompt 040 adds `/properties/new` and
 * `/properties/:id/edit`; Prompt 044 adds `/leads`, `/leads/new`, `/leads/:id`, and
 * `/leads/:id/edit`) — exported separately from `router` so tests can feed the exact same route
 * objects into `createMemoryRouter` (`src/test/render.tsx`) instead of redeclaring routes.
 * `/properties/new` and `/leads/new` are each declared before their sibling `:id` route — React
 * Router ranks static segments over dynamic ones regardless of array order, but the order here
 * stays readable either way (Prompt 040, section 4; Prompt 044, section 5): `new` is never
 * captured as `:id`.
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
    path: "/properties/new",
    element: <NewPropertyPage />,
    errorElement: <RootErrorBoundary />,
  },
  {
    path: "/properties/:id",
    element: <PropertyDetailsPage />,
    errorElement: <RootErrorBoundary />,
  },
  {
    path: "/properties/:id/edit",
    element: <EditPropertyPage />,
    errorElement: <RootErrorBoundary />,
  },
  {
    path: "/leads",
    element: <LeadsPage />,
    errorElement: <RootErrorBoundary />,
  },
  {
    path: "/leads/new",
    element: <NewLeadPage />,
    errorElement: <RootErrorBoundary />,
  },
  {
    path: "/leads/:id",
    element: <LeadDetailsPage />,
    errorElement: <RootErrorBoundary />,
  },
  {
    path: "/leads/:id/edit",
    element: <EditLeadPage />,
    errorElement: <RootErrorBoundary />,
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
];

export const router = createBrowserRouter(routes);
