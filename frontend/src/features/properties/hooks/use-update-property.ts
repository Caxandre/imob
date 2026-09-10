import { useMutation, useQueryClient } from "@tanstack/react-query";

import { updateProperty } from "../api/update-property";
import { propertyQueryKeys } from "./use-property";
import { propertiesQueryKeys } from "./use-properties";

/**
 * Prompt 040, section 32: after a successful PATCH, the detail cache is seeded directly with
 * the fresh response (`setQueryData`, no extra refetch/flash) and the catalog list cache for
 * this tenant is invalidated — the edited property's title/price/etc. may be visible there too.
 * Media is never touched by this mutation, so its cache is never invalidated (section 59/76).
 */
export function useUpdateProperty(tenantId: string, propertyId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Parameters<typeof updateProperty>[2]) =>
      updateProperty(tenantId, propertyId, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(propertyQueryKeys.detail(tenantId, propertyId), updated);
      void queryClient.invalidateQueries({ queryKey: propertiesQueryKeys.all(tenantId) });
    },
  });
}
