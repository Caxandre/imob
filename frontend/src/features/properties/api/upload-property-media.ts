import { apiFetch } from "@/lib/http/api-fetch";

import { propertyMediaSchema, type PropertyMedia } from "../schemas/property-media.schema";

/**
 * `POST /api/v1/properties/:id/media` (Prompt 041, section 2/5) — `multipart/form-data` with a
 * single field named `"file"`, verified directly against
 * `backend/src/modules/properties/http/property-routes.ts`. Uses `FormData` (section 6) —
 * never `apiFetch`'s JSON path, never a manually-set `Content-Type` (the browser generates the
 * multipart boundary). One request per file; the backend accepts exactly one file per call, so
 * multiple files are uploaded as separate calls (see `useUploadPropertyMedia`), never batched
 * into one request.
 */
export async function uploadPropertyMedia(
  tenantId: string,
  propertyId: string,
  file: File,
): Promise<PropertyMedia> {
  const formData = new FormData();
  formData.append("file", file);

  const data = await apiFetch<unknown>(`/api/v1/properties/${propertyId}/media`, {
    method: "POST",
    headers: { "X-Tenant-Id": tenantId },
    body: formData,
  });

  return propertyMediaSchema.parse(data);
}
