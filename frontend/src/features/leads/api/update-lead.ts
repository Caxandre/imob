import { apiFetch } from "@/lib/http/api-fetch";

import type { UpdateLeadInput } from "../schemas/lead-form.schema";
import { leadSchema, type Lead } from "../schemas/lead.schema";

/**
 * `PATCH /api/v1/leads/:id` (Prompt 044, sections 8/58/94). `input` is a partial object — only
 * the fields `pickDirtyLeadFormFields` decided are dirty — sent exactly as given: an omitted
 * key stays unchanged server-side, a key present with `null` clears it. This function never
 * decides which fields to include. The response never carries `property` (section 66) — callers
 * that need an up-to-date property summary must invalidate/refetch the detail query instead of
 * relying on this response.
 */
export async function updateLead(
  tenantId: string,
  leadId: string,
  input: UpdateLeadInput,
): Promise<Lead> {
  const data = await apiFetch<unknown>(`/api/v1/leads/${leadId}`, {
    method: "PATCH",
    headers: { "X-Tenant-Id": tenantId },
    body: input,
  });

  return leadSchema.parse(data);
}
