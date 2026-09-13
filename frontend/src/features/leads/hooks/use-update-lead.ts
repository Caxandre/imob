import { useMutation, useQueryClient } from "@tanstack/react-query";

import { updateLead } from "../api/update-lead";
import { leadKeys } from "./use-leads";

/**
 * After a successful `PATCH`, both the detail cache and the list cache for this tenant are
 * invalidated (section 63/68) — deliberately never `setQueryData` with the mutation's own
 * response here, unlike `useUpdateProperty`: the `PATCH` response (`Lead`) never carries
 * `property` (section 66/67), while the detail cache holds the richer `LeadWithProperty` shape.
 * Seeding the cache with the bare response would silently drop the property summary until the
 * next unrelated refetch. Invalidating instead forces a real `GET /leads/:id`, which is the only
 * place the property summary is computed (a single `LEFT JOIN`, never re-derived on the client
 * — section 66: "não inventar summary no cliente").
 */
export function useUpdateLead(tenantId: string, leadId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Parameters<typeof updateLead>[2]) => updateLead(tenantId, leadId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leadKeys.detail(tenantId, leadId) });
      void queryClient.invalidateQueries({ queryKey: leadKeys.all(tenantId) });
    },
  });
}
