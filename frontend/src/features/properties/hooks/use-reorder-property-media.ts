import { useMutation, useQueryClient } from "@tanstack/react-query";

import { reorderPropertyMedia } from "../api/reorder-property-media";
import { propertyMediaQueryKeys } from "./use-property-media";

/**
 * Prompt 041, section 79: reorder never changes which media is the cover (the backend never
 * touches `is_cover` on reorder), so only the media query is invalidated — the properties
 * catalog cache is left alone.
 */
export function useReorderPropertyMedia(tenantId: string, propertyId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mediaIds: string[]) => reorderPropertyMedia(tenantId, propertyId, mediaIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: propertyMediaQueryKeys.list(tenantId, propertyId),
      });
    },
  });
}
