import { useMutation, useQueryClient } from "@tanstack/react-query";

import { setPropertyMediaCover } from "../api/set-property-media-cover";
import { propertyMediaQueryKeys } from "./use-property-media";
import { propertiesQueryKeys } from "./use-properties";

/**
 * Prompt 041, sections 11/12/33: setting a cover always changes what the catalog should show
 * for this property, so both the media query and the properties list cache are invalidated —
 * plain invalidation, no optimistic update or manual cache splicing (section 34: the backend
 * stays the single authority for which media is the cover).
 */
export function useSetPropertyMediaCover(tenantId: string, propertyId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mediaId: string) => setPropertyMediaCover(tenantId, propertyId, mediaId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: propertyMediaQueryKeys.list(tenantId, propertyId),
      });
      void queryClient.invalidateQueries({ queryKey: propertiesQueryKeys.all(tenantId) });
    },
  });
}
