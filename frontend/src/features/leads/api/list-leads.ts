import { apiFetch } from "@/lib/http/api-fetch";

import { dateOnlyToRangeEndIso, dateOnlyToRangeStartIso } from "../lib/lead-date-range";
import type { LeadFilters } from "../schemas/lead-filters.schema";
import { leadListResponseSchema, type LeadListResponse } from "../schemas/lead.schema";

/**
 * `GET /api/v1/leads` (Prompt 044, sections 8/91). `X-Tenant-Id` is passed explicitly here,
 * scoped to this one call — never global on `apiFetch()` (same convention as
 * `listProperties`). `created_from`/`created_to` are expanded from the URL's plain calendar
 * date into the full ISO-8601-with-offset datetime the API expects (see
 * `lib/lead-date-range.ts`) only here, at the HTTP boundary — the URL/filter object itself never
 * stores the expanded form. The response is validated with Zod before anything downstream
 * touches it.
 */
export async function listLeads(tenantId: string, filters: LeadFilters): Promise<LeadListResponse> {
  const params = new URLSearchParams();

  if (filters.q !== undefined) params.set("q", filters.q);
  if (filters.status !== undefined) params.set("status", filters.status);
  if (filters.source !== undefined) params.set("source", filters.source);
  if (filters.property_id !== undefined) params.set("property_id", filters.property_id);
  if (filters.created_from !== undefined) {
    params.set("created_from", dateOnlyToRangeStartIso(filters.created_from));
  }
  if (filters.created_to !== undefined) {
    params.set("created_to", dateOnlyToRangeEndIso(filters.created_to));
  }
  if (filters.page !== undefined) params.set("page", String(filters.page));

  const query = params.toString();
  const path = `/api/v1/leads${query ? `?${query}` : ""}`;

  const data = await apiFetch<unknown>(path, {
    headers: { "X-Tenant-Id": tenantId },
  });

  return leadListResponseSchema.parse(data);
}
