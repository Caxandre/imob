import { apiFetch } from "@/lib/http/api-fetch";

import type { PropertyFormOutput } from "../schemas/property-form.schema";
import { propertyDetailSchema, type PropertyDetail } from "../schemas/property.schema";

/**
 * `POST /api/v1/properties` (Prompt 040, sections 3/25). `input` is already the normalized,
 * validated output of `propertyFormSchema` — never raw form strings. The response never
 * carries `cover` (same shape as `GET /properties/:id`), so it reuses `propertyDetailSchema`
 * rather than a third near-identical schema.
 */
export async function createProperty(
  tenantId: string,
  input: PropertyFormOutput,
): Promise<PropertyDetail> {
  const data = await apiFetch<unknown>("/api/v1/properties", {
    method: "POST",
    headers: { "X-Tenant-Id": tenantId },
    body: input,
  });

  return propertyDetailSchema.parse(data);
}
