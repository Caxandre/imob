import { apiFetch } from "@/lib/http/api-fetch";

import { propertyDetailSchema, type PropertyDetail } from "../schemas/property.schema";

/**
 * `GET /api/v1/properties/:id` (Prompt 038, sections 3/9). The property id must already be a
 * validated UUID before this is called (`PropertyDetailsPage` never invokes it with an
 * obviously-invalid id, section 7) — this function does not re-validate it, only the response.
 * `X-Tenant-Id` is scoped to this one call, same as the rest of the Properties feature (section
 * 8) — never global on `apiFetch()`.
 */
export async function getPropertyById(
  tenantId: string,
  propertyId: string,
): Promise<PropertyDetail> {
  const data = await apiFetch<unknown>(`/api/v1/properties/${propertyId}`, {
    headers: { "X-Tenant-Id": tenantId },
  });

  return propertyDetailSchema.parse(data);
}
