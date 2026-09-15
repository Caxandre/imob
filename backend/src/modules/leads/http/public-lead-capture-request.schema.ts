import { z } from "zod";

import { UUID_PATTERN } from "../../properties/http/property-request.schema.js";
import {
  CONTACT_CHANNEL_REQUIRED_MESSAGE,
  MESSAGE_MAX_LENGTH,
  NAME_MAX_LENGTH,
  optionalEmail,
  optionalPhone,
  optionalText,
  requireContactChannel,
} from "./lead-contact.schema.js";

/**
 * Route params for `POST /api/v1/public/properties/:propertyId/leads` (Prompt 045, section 12)
 * — `propertyId` comes exclusively from the URL, never the body, so a client can never send a
 * URL property and a different body `property_id`.
 */
export const capturePropertyLeadParamsSchema = z.object({
  propertyId: z.string().trim().regex(UUID_PATTERN, "propertyId must be a valid UUID"),
});

export type CapturePropertyLeadParams = z.infer<typeof capturePropertyLeadParamsSchema>;

/**
 * Public request body (Prompt 045, sections 5-11/18) — a deliberately restricted, standalone
 * contract, never `createLeadBodySchema` relaxed or reused: `status`/`source`/`notes`/
 * `property_id`/`id`/`created_at`/`updated_at` are not part of this shape at all, so `.strict()`
 * rejects any of them as an unknown field (400) rather than silently discarding them — a client
 * attempting to smuggle `status: "WON"` gets the same 400 as any other malformed request, never
 * a silent ignore.
 */
export const capturePropertyLeadBodySchema = z
  .object({
    name: z.string().trim().min(1, "name must not be empty").max(NAME_MAX_LENGTH),
    email: optionalEmail(),
    phone: optionalPhone(),
    message: optionalText(MESSAGE_MAX_LENGTH),
  })
  .strict()
  .refine(requireContactChannel, { message: CONTACT_CHANNEL_REQUIRED_MESSAGE, path: ["email"] });

export type CapturePropertyLeadBody = z.infer<typeof capturePropertyLeadBodySchema>;
