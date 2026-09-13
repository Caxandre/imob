import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { listLeads } from "../api/list-leads";
import type { LeadFilters } from "../schemas/lead-filters.schema";

/**
 * Query key factory (Prompt 044, section 10) — the tenant id is part of every key, not just the
 * fetch call, so server-state cache from one tenant can never leak into another's cache entry
 * (same reasoning as `propertiesQueryKeys`). Shared by every Leads hook — `useLead`,
 * `useCreateLead`, and `useUpdateLead` all import `leadKeys` from here rather than declaring
 * their own.
 */
export const leadKeys = {
  all: (tenantId: string) => ["leads", tenantId] as const,
  list: (tenantId: string, filters: LeadFilters) => ["leads", tenantId, "list", filters] as const,
  detail: (tenantId: string, leadId: string) => ["leads", tenantId, "detail", leadId] as const,
};

/**
 * Server state for the lead list (section 11). `placeholderData: keepPreviousData` keeps the
 * previous page's rows on screen while a new filter/page fetches, same convention as
 * `useProperties`.
 */
export function useLeads(tenantId: string, filters: LeadFilters) {
  return useQuery({
    queryKey: leadKeys.list(tenantId, filters),
    queryFn: () => listLeads(tenantId, filters),
    placeholderData: keepPreviousData,
  });
}
