import { apiFetch } from "@/lib/http/api-fetch";

/**
 * `DELETE /api/v1/properties/:id` (Prompt 042, sections 2/6/12) — verified directly against
 * `backend/src/modules/properties/http/property-routes.ts`/`archive-property.ts`: this is a
 * semantic archive (`status` set to `INACTIVE`), never a physical delete — the row and its
 * history are preserved. Idempotent: archiving an already-`INACTIVE` property still resolves
 * with `204`. `apiFetch` already resolves a 204 to `undefined` without attempting to parse a
 * body, reused as-is here — no response schema to validate.
 */
export async function archiveProperty(tenantId: string, propertyId: string): Promise<void> {
  await apiFetch<undefined>(`/api/v1/properties/${propertyId}`, {
    method: "DELETE",
    headers: { "X-Tenant-Id": tenantId },
  });
}
