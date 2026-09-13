import { apiFetch } from "@/lib/http/api-fetch";

import { leadWithPropertySchema, type LeadWithProperty } from "../schemas/lead.schema";

/**
 * `GET /api/v1/leads/:id` (Prompt 044, sections 8/92). The lead id must already be a validated
 * UUID before this is called (`LeadDetailsPage`, section 29) — this function does not
 * re-validate it, only the response. The property summary (when present) comes back inline on
 * `property` — never a follow-up request for the associated Property (section 31/32).
 */
export async function getLeadById(tenantId: string, leadId: string): Promise<LeadWithProperty> {
  const data = await apiFetch<unknown>(`/api/v1/leads/${leadId}`, {
    headers: { "X-Tenant-Id": tenantId },
  });

  return leadWithPropertySchema.parse(data);
}
