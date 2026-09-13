import { apiFetch } from "@/lib/http/api-fetch";

import type { CreateLeadInput } from "../schemas/lead-form.schema";
import { leadSchema, type Lead } from "../schemas/lead.schema";

/**
 * `POST /api/v1/leads` (Prompt 044, sections 8/52/93). `input` is already the normalized,
 * validated output of `leadFormSchema` with `status` stripped (`toCreateLeadInput`) — never raw
 * form strings, and `status` is never sent (the backend always creates as `NEW`). The response
 * never carries `property` (same shape as the `PATCH` response), so it reuses `leadSchema`
 * rather than a third near-identical schema.
 */
export async function createLead(tenantId: string, input: CreateLeadInput): Promise<Lead> {
  const data = await apiFetch<unknown>("/api/v1/leads", {
    method: "POST",
    headers: { "X-Tenant-Id": tenantId },
    body: input,
  });

  return leadSchema.parse(data);
}
