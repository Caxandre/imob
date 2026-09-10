import { useQuery } from "@tanstack/react-query";

import { listPropertyMedia } from "../api/list-property-media";

export const propertyMediaQueryKeys = {
  list: (tenantId: string, propertyId: string) => ["property-media", tenantId, propertyId] as const,
};

/**
 * Independent from `useProperty` (Prompt 038, section 12) — both are meant to be mounted
 * together by the page so TanStack Query fires them in parallel, never one gated behind the
 * other's completion.
 */
export function usePropertyMedia(tenantId: string, propertyId: string) {
  return useQuery({
    queryKey: propertyMediaQueryKeys.list(tenantId, propertyId),
    queryFn: () => listPropertyMedia(tenantId, propertyId),
  });
}
