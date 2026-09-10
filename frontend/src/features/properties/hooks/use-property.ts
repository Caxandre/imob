import { useQuery } from "@tanstack/react-query";

import { getPropertyById } from "../api/get-property";

// Tenant id is part of the key (Prompt 038, section 11), same reasoning as
// `propertiesQueryKeys` — cache from one tenant must never leak into another's entry.
export const propertyQueryKeys = {
  detail: (tenantId: string, propertyId: string) => ["property", tenantId, propertyId] as const,
};

export function useProperty(tenantId: string, propertyId: string) {
  return useQuery({
    queryKey: propertyQueryKeys.detail(tenantId, propertyId),
    queryFn: () => getPropertyById(tenantId, propertyId),
  });
}
