import { useMutation, useQueryClient } from "@tanstack/react-query";

import { archiveProperty } from "../api/archive-property";
import { propertyQueryKeys } from "./use-property";
import { propertiesQueryKeys } from "./use-properties";

/**
 * Prompt 042, sections 19/20: `DELETE` returns `204` (no fresh property to seed the cache
 * with, unlike `useUpdateProperty`), so the detail query is invalidated rather than seeded —
 * this also drives `PropertyMediaManager`'s upload-disabled state to update immediately if the
 * edit page is open, since it reads `property.status` from the same query key. The catalog
 * list is invalidated too, since archiving can change what a card shows.
 */
export function useArchiveProperty(tenantId: string, propertyId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => archiveProperty(tenantId, propertyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: propertyQueryKeys.detail(tenantId, propertyId),
      });
      void queryClient.invalidateQueries({ queryKey: propertiesQueryKeys.all(tenantId) });
    },
  });
}
