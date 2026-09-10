import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deletePropertyMedia } from "../api/delete-property-media";
import { propertyMediaQueryKeys } from "./use-property-media";
import { propertiesQueryKeys } from "./use-properties";

/**
 * Prompt 041, sections 37/74/80: deleting the current cover makes the backend promote a new one
 * itself — the frontend never picks a replacement, it only invalidates and lets the next
 * fetch/refetch show whatever the backend decided.
 */
export function useDeletePropertyMedia(tenantId: string, propertyId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mediaId: string) => deletePropertyMedia(tenantId, propertyId, mediaId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: propertyMediaQueryKeys.list(tenantId, propertyId),
      });
      void queryClient.invalidateQueries({ queryKey: propertiesQueryKeys.all(tenantId) });
    },
  });
}
