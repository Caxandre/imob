import { useMutation } from "@tanstack/react-query";

import { capturePropertyLead, type CapturePropertyLeadInput } from "../api/capture-property-lead";

/**
 * Prompt 046, sections 53/54/55: deliberately no `onSuccess` cache invalidation at all — a
 * visitor's public lead submission has no reason to know about, or invalidate, any TanStack
 * Query cache (`properties`, `property media`, or the administrative `leadKeys`). The public and
 * administrative surfaces stay fully decoupled. No `retry` override either — mutations default
 * to no automatic retry, which is exactly what a rate-limited/validated POST needs (section 27).
 */
export function useCapturePropertyLead(tenantId: string, propertyId: string) {
  return useMutation({
    mutationFn: (input: CapturePropertyLeadInput) =>
      capturePropertyLead(tenantId, propertyId, input),
  });
}
