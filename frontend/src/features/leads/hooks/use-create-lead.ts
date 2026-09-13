import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createLead } from "../api/create-lead";
import { leadKeys } from "./use-leads";

/**
 * After a successful create, the list cache for this tenant is invalidated (matches every
 * filter/page variant already cached, via the shared `["leads", tenantId]` prefix — section 68)
 * so a newly created lead shows up on refetch. The new lead's own detail cache doesn't need
 * seeding here — navigating to `/leads/:id` triggers its own fresh `useLead` fetch.
 */
export function useCreateLead(tenantId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Parameters<typeof createLead>[1]) => createLead(tenantId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leadKeys.all(tenantId) });
    },
  });
}
