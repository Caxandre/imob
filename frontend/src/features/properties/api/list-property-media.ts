import { apiFetch } from "@/lib/http/api-fetch";

import {
  propertyMediaListResponseSchema,
  type PropertyMediaListResponse,
} from "../schemas/property-media.schema";

/**
 * `GET /api/v1/properties/:id/media` (Prompt 038, sections 9/61). Exactly one request per
 * property detail load — never a follow-up call per media item; every display URL needed
 * (thumbnail/card/detail/original) already comes back inline on each item.
 */
export async function listPropertyMedia(
  tenantId: string,
  propertyId: string,
): Promise<PropertyMediaListResponse> {
  const data = await apiFetch<unknown>(`/api/v1/properties/${propertyId}/media`, {
    headers: { "X-Tenant-Id": tenantId },
  });

  return propertyMediaListResponseSchema.parse(data);
}
