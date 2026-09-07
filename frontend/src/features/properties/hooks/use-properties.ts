import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { listProperties } from "../api/list-properties";
import type { PropertyFilters } from "../schemas/property-filters.schema";

/**
 * Query key factory (Prompt 037B, section 32) — the tenant id is part of the key, not just the
 * fetch call, so server-state cache from one tenant can never leak into another's cache entry
 * even though only one tenant is configured per environment today.
 */
export const propertiesQueryKeys = {
  all: (tenantId: string) => ["properties", tenantId] as const,
  list: (tenantId: string, filters: PropertyFilters) => ["properties", tenantId, filters] as const,
};

/**
 * Server state for the property catalog (Prompt 037B, section 31). `placeholderData:
 * keepPreviousData` (section 56 — the current, non-deprecated TanStack Query v5 API) keeps the
 * previous page's cards on screen while a new filter/page/sort fetches, instead of flashing the
 * whole grid back to a loading state; `isFetching` (vs. `isPending`) lets the caller show a
 * discreet background-refetch indicator (section 57).
 */
export function useProperties(tenantId: string, filters: PropertyFilters) {
  return useQuery({
    queryKey: propertiesQueryKeys.list(tenantId, filters),
    queryFn: () => listProperties(tenantId, filters),
    placeholderData: keepPreviousData,
  });
}
