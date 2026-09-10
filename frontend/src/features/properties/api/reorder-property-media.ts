import { apiFetch } from "@/lib/http/api-fetch";

import {
  propertyMediaListResponseSchema,
  type PropertyMediaListResponse,
} from "../schemas/property-media.schema";

/**
 * `PUT /api/v1/properties/:id/media/order` (Prompt 041, sections 2/39/42/43) — `mediaIds` must
 * be exactly the property's current gallery (no fewer, no more, no duplicates), in the new
 * order; callers never send a partial list — see `useReorderPropertyMedia`/
 * `PropertyMediaManager` for how the full set is built locally before this is called.
 */
export async function reorderPropertyMedia(
  tenantId: string,
  propertyId: string,
  mediaIds: string[],
): Promise<PropertyMediaListResponse> {
  const data = await apiFetch<unknown>(`/api/v1/properties/${propertyId}/media/order`, {
    method: "PUT",
    headers: { "X-Tenant-Id": tenantId },
    body: { media_ids: mediaIds },
  });

  return propertyMediaListResponseSchema.parse(data);
}
