import { z } from "zod";

/**
 * `POST /api/v1/public/properties/:propertyId/leads` response (Prompt 046, sections 3/56/57) —
 * verified directly against `backend/src/modules/leads/http/public-lead-capture-routes.ts`
 * (`reply.status(201).send({ id: lead.id })`) and its OpenAPI schema
 * (`capturePropertyLeadResponseSchema`, `required: ["id"]`). Deliberately minimal: no echoed
 * PII, no `status`/`source`/`property` — just the created lead's id.
 */
export const capturePropertyLeadResponseSchema = z.object({
  id: z.string(),
});
export type CapturePropertyLeadResponse = z.infer<typeof capturePropertyLeadResponseSchema>;
