import { apiFetch } from "@/lib/http/api-fetch";

import type { PropertyFormOutput } from "../schemas/property-form.schema";
import { propertyDetailSchema, type PropertyDetail } from "../schemas/property.schema";

/**
 * `PATCH /api/v1/properties/:id` (Prompt 040, sections 3/26/27). `input` is a partial object —
 * only the fields the caller decided are dirty (see `pickDirtyFormFields`) — sent exactly as
 * given: an omitted key stays unchanged server-side, a key present with `null` clears it. This
 * function never decides which fields to include; that decision already happened before this
 * is called.
 */
export async function updateProperty(
  tenantId: string,
  propertyId: string,
  input: Partial<PropertyFormOutput>,
): Promise<PropertyDetail> {
  const data = await apiFetch<unknown>(`/api/v1/properties/${propertyId}`, {
    method: "PATCH",
    headers: { "X-Tenant-Id": tenantId },
    body: input,
  });

  return propertyDetailSchema.parse(data);
}
