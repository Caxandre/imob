import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createProperty } from "../api/create-property";
import { propertiesQueryKeys } from "./use-properties";

/**
 * Prompt 040, section 31: after a successful create, the catalog list cache for this tenant is
 * invalidated (matches every filter/page variant already cached, via the shared `["properties",
 * tenantId]` prefix) so a newly created property shows up on refetch. The new property's own
 * detail cache doesn't need seeding here — navigating to `/properties/:id` triggers its own
 * fresh `useProperty` fetch.
 */
export function useCreateProperty(tenantId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Parameters<typeof createProperty>[1]) => createProperty(tenantId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: propertiesQueryKeys.all(tenantId) });
    },
  });
}
