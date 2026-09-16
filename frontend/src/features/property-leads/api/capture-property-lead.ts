import { apiFetch } from "@/lib/http/api-fetch";

import {
  capturePropertyLeadResponseSchema,
  type CapturePropertyLeadResponse,
} from "../schemas/capture-property-lead-response.schema";
import type { PropertyInterestFormOutput } from "../schemas/property-interest-form.schema";

// The exact, restricted public request payload (Prompt 046, sections 9/35/36/37) — never
// `status`/`source`/`notes`/`property_id`. `propertyId` is a URL param, never a body field.
export type CapturePropertyLeadInput = PropertyInterestFormOutput;

/**
 * `POST /api/v1/public/properties/:propertyId/leads` (Prompt 046, sections 6/34) — the
 * restricted public lead-capture contract, verified directly against
 * `backend/src/modules/leads/http/public-lead-capture-routes.ts`. Deliberately separate from the
 * administrative `createLead()` (`frontend/src/features/leads/api/create-lead.ts`), which posts
 * to a different, unauthenticated-incompatible endpoint with a different (snake_case, richer)
 * contract. `X-Tenant-Id` is sent as a temporary routing header, never authentication (section 7).
 */
export async function capturePropertyLead(
  tenantId: string,
  propertyId: string,
  input: CapturePropertyLeadInput,
): Promise<CapturePropertyLeadResponse> {
  const data = await apiFetch<unknown>(`/api/v1/public/properties/${propertyId}/leads`, {
    method: "POST",
    headers: { "X-Tenant-Id": tenantId },
    body: input,
  });

  return capturePropertyLeadResponseSchema.parse(data);
}
