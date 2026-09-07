import { apiFetch } from "@/lib/http/api-fetch";

import { serializePropertyFilters, type PropertyFilters } from "../schemas/property-filters.schema";
import { propertyListResponseSchema, type PropertyListResponse } from "../schemas/property.schema";

/**
 * `GET /api/v1/properties` (Prompt 037B, sections 12-14). This is the ONLY request this feature
 * makes to list properties — the cover image comes back inline on each item (`property.cover`),
 * so there is never a follow-up `GET /properties/:id/media` per card (no N+1). `X-Tenant-Id` is
 * passed explicitly here, scoped to this one call — `apiFetch()` itself never sets it (section
 * 11: Control Plane vs. Tenant Data Plane are different contexts, so the header is never global).
 * The response is validated with Zod at the HTTP boundary before anything downstream touches it.
 */
export async function listProperties(
  tenantId: string,
  filters: PropertyFilters,
): Promise<PropertyListResponse> {
  const query = serializePropertyFilters(filters).toString();
  const path = `/api/v1/properties${query ? `?${query}` : ""}`;

  const data = await apiFetch<unknown>(path, {
    headers: { "X-Tenant-Id": tenantId },
  });

  return propertyListResponseSchema.parse(data);
}
