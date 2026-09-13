import { useQuery } from "@tanstack/react-query";

import { getLeadById } from "../api/get-lead";
import { leadKeys } from "./use-leads";

export function useLead(tenantId: string, leadId: string) {
  return useQuery({
    queryKey: leadKeys.detail(tenantId, leadId),
    queryFn: () => getLeadById(tenantId, leadId),
  });
}
