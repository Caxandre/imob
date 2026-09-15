import { EMAIL_MAX_LENGTH, MESSAGE_MAX_LENGTH, NAME_MAX_LENGTH, PHONE_MAX_LENGTH } from "./lead-contact.schema.js";

/**
 * `email`/`phone` are documented as `string, nullable` (never `format: "email"` enforced here)
 * for the same AJV-runs-before-Zod reason already documented on the administrative Leads/
 * Properties request schemas — `capturePropertyLeadBodySchema` (Zod) validates the real format
 * after normalization.
 */
export const capturePropertyLeadRequestSchema = {
  $id: "CapturePropertyLeadRequest",
  title: "CapturePropertyLeadRequest",
  type: "object",
  description:
    "Unauthenticated public lead capture endpoint. Tenant routing currently uses X-Tenant-Id " +
    "until public tenant discovery is implemented. At least one of \"email\"/\"phone\" is " +
    'required. Administrative fields ("status", "source", "notes", "property_id") are not ' +
    "accepted here — the property comes from the URL, and the lead is always created as NEW/WEBSITE.",
  properties: {
    name: { type: "string", description: `Trimmed; required, at most ${NAME_MAX_LENGTH} characters.` },
    email: {
      type: "string",
      nullable: true,
      description: `Trimmed and lowercased; at most ${EMAIL_MAX_LENGTH} characters.`,
    },
    phone: {
      type: "string",
      nullable: true,
      description: `Trimmed; at most ${PHONE_MAX_LENGTH} characters. Stored as-is, no DDI/DDD parsing.`,
    },
    message: {
      type: "string",
      nullable: true,
      description: `Trimmed; at most ${MESSAGE_MAX_LENGTH} characters.`,
    },
  },
  examples: [
    {
      name: "Maria Souza",
      email: "maria.souza@example.com",
      message: "Tenho interesse neste apartamento.",
    },
  ],
} as const;

/**
 * Minimal confirmation response (Prompt 045, sections 24-25) — never echoes the submitted
 * PII (`name`/`email`/`phone`/`message`) and never exposes internal lead fields
 * (`status`/`source`/`notes`/`property_id`) or property metadata.
 */
export const capturePropertyLeadResponseSchema = {
  $id: "CapturePropertyLeadResponse",
  title: "CapturePropertyLeadResponse",
  type: "object",
  description: "Minimal confirmation that the lead was captured.",
  properties: {
    id: { type: "string", format: "uuid" },
  },
  required: ["id"],
  examples: [{ id: "7c2e5a1b-4d6f-4a8c-b3e7-1f9a2d5c8e40" }],
} as const;
