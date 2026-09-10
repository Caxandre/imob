import { apiFetch } from "@/lib/http/api-fetch";

import { propertyMediaSchema, type PropertyMedia } from "../schemas/property-media.schema";

/**
 * `PATCH /api/v1/properties/:id/media/:mediaId/cover` (Prompt 041, section 2/32) — no request
 * body; idempotent on the backend (selecting the already-current cover still returns 200).
 */
export async function setPropertyMediaCover(
  tenantId: string,
  propertyId: string,
  mediaId: string,
): Promise<PropertyMedia> {
  const data = await apiFetch<unknown>(`/api/v1/properties/${propertyId}/media/${mediaId}/cover`, {
    method: "PATCH",
    headers: { "X-Tenant-Id": tenantId },
  });

  return propertyMediaSchema.parse(data);
}
