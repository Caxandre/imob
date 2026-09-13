import { z } from "zod";

import { apiFetch } from "@/lib/http/api-fetch";
import { propertyStatusSchema } from "@/features/properties/schemas/property.schema";

/**
 * Backs the property association `<select>` in `LeadForm` (Prompt 044, sections 47/48). The
 * frontend has no dedicated property-search endpoint yet, and building an autocomplete against
 * one that doesn't exist would be worse than not having one — so this is deliberately a single,
 * bounded `GET /api/v1/properties?limit=100` (the backend's own max page size), never every
 * page. Only `id`/`title`/`status` are validated — this is not the full `Property` shape, and
 * intentionally lives in the Leads feature (not imported from Properties' own API functions,
 * which are shaped around the URL-driven catalog page, not a bounded dropdown).
 *
 * `truncated` tells the caller whether more properties exist than fit in this one page (section
 * 48: "não criar autocomplete incompleto disfarçado de completo") — the UI must disclose this
 * rather than silently pretending the list is exhaustive.
 */
const PROPERTY_OPTIONS_LIMIT = 100;

const propertyOptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: propertyStatusSchema,
});
export type PropertyOption = z.infer<typeof propertyOptionSchema>;

const propertyOptionsResponseSchema = z.object({
  data: z.array(propertyOptionSchema),
  pagination: z.object({ total: z.number() }),
});

export interface PropertyOptionsResult {
  options: PropertyOption[];
  truncated: boolean;
}

export async function listPropertyOptions(tenantId: string): Promise<PropertyOptionsResult> {
  const data = await apiFetch<unknown>(`/api/v1/properties?limit=${PROPERTY_OPTIONS_LIMIT}`, {
    headers: { "X-Tenant-Id": tenantId },
  });

  const parsed = propertyOptionsResponseSchema.parse(data);
  return { options: parsed.data, truncated: parsed.pagination.total > parsed.data.length };
}
