import { useQuery } from "@tanstack/react-query";

import { listPropertyOptions } from "../api/list-property-options";

// Deliberately its own top-level key, not nested under `leadKeys` (Prompt 044, section 10) —
// this list of properties is unrelated to lead server state, so a lead create/update
// invalidation must never refetch it.
export const propertyOptionsQueryKeys = {
  list: (tenantId: string) => ["lead-property-options", tenantId] as const,
};

export function usePropertyOptions(tenantId: string) {
  return useQuery({
    queryKey: propertyOptionsQueryKeys.list(tenantId),
    queryFn: () => listPropertyOptions(tenantId),
  });
}
