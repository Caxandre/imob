import { apiFetch } from "@/lib/http/api-fetch";

/**
 * `DELETE /api/v1/properties/:id/media/:mediaId` (Prompt 041, section 2/35/38) — `204 No
 * Content` on success; `apiFetch` already resolves a 204 to `undefined` without attempting to
 * parse a body (`src/lib/http/api-fetch.ts`), reused as-is here — no response schema to
 * validate. The backend reindexes remaining positions and promotes a new cover itself if the
 * deleted media was the cover (this task never re-derives that client-side, section 37/80).
 */
export async function deletePropertyMedia(
  tenantId: string,
  propertyId: string,
  mediaId: string,
): Promise<void> {
  await apiFetch<undefined>(`/api/v1/properties/${propertyId}/media/${mediaId}`, {
    method: "DELETE",
    headers: { "X-Tenant-Id": tenantId },
  });
}
