import {
  EMAIL_MAX_LENGTH,
  LEAD_SOURCES,
  LEAD_STATUSES,
  MESSAGE_MAX_LENGTH,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PHONE_MAX_LENGTH,
} from "./lead-request.schema.js";

// Reused as-is (Prompt 043, section 61) — the same temporary Tenant Data Plane header every
// Properties route already documents, never a second/duplicated definition.
export { tenantIdHeaderSchema } from "../../properties/http/property-openapi.schema.js";

const EXAMPLE_LEAD = {
  id: "7c2e5a1b-4d6f-4a8c-b3e7-1f9a2d5c8e40",
  property_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  name: "Maria Souza",
  email: "maria.souza@example.com",
  phone: "+55 11 99999-0000",
  status: "NEW",
  source: "MANUAL",
  message: "Tenho interesse neste apartamento.",
  notes: null,
  created_at: "2026-08-27T12:00:00.000Z",
  updated_at: "2026-08-27T12:00:00.000Z",
} as const;

/**
 * `email`/`phone` are documented as `string, nullable` (never `format: "email"` enforced here)
 * for the same AJV-runs-before-Zod reason already documented on Properties' own request
 * schemas (`property-openapi.schema.ts`) — `createLeadBodySchema`/`updateLeadBodySchema` (Zod)
 * validate the real format after normalization; encoding it here too would let AJV reject a
 * request with its own generic error shape instead of this API's own `{statusCode, error,
 * message, details}` envelope.
 */
export const createLeadRequestSchema = {
  $id: "CreateLeadRequest",
  title: "CreateLeadRequest",
  type: "object",
  description:
    `At least one of "email"/"phone" is required. "status" is never accepted here — a new ` +
    `lead is always created as NEW.`,
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
    property_id: {
      type: "string",
      format: "uuid",
      nullable: true,
      description: "Must resolve to a property in this same tenant's database, of any status.",
    },
    source: { type: "string", description: `One of: ${LEAD_SOURCES.join(", ")}. Defaults to MANUAL.` },
    message: { type: "string", nullable: true, description: `Trimmed; at most ${MESSAGE_MAX_LENGTH} characters.` },
    notes: { type: "string", nullable: true, description: `Trimmed; at most ${NOTES_MAX_LENGTH} characters.` },
  },
  examples: [
    {
      name: "Maria Souza",
      email: "maria.souza@example.com",
      phone: "+55 11 99999-0000",
      property_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      source: "MANUAL",
      message: "Tenho interesse neste apartamento.",
    },
  ],
} as const;

/**
 * Deliberately not `createLeadRequestSchema` reused/relaxed — every field here is genuinely
 * optional (a PATCH may send any subset), and "at least one contact channel" is validated
 * against the *resulting* persisted state by the application layer, never expressible as a
 * static JSON Schema constraint here.
 */
export const updateLeadRequestSchema = {
  $id: "UpdateLeadRequest",
  title: "UpdateLeadRequest",
  type: "object",
  description: "Any subset of the editable lead fields. At least one must be present.",
  properties: {
    name: { type: "string", description: `Trimmed; at most ${NAME_MAX_LENGTH} characters.` },
    email: { type: "string", nullable: true, description: "Send null to clear it." },
    phone: { type: "string", nullable: true, description: "Send null to clear it." },
    property_id: { type: "string", format: "uuid", nullable: true, description: "Send null to clear it." },
    status: { type: "string", description: `One of: ${LEAD_STATUSES.join(", ")}.` },
    source: { type: "string", description: `One of: ${LEAD_SOURCES.join(", ")}.` },
    message: { type: "string", nullable: true, description: "Send null to clear it." },
    notes: { type: "string", nullable: true, description: "Send null to clear it." },
  },
  examples: [{ status: "CONTACTED", notes: "Ligar amanhã de manhã." }],
} as const;

const LEAD_PROPERTY_SUMMARY_PROPERTY = {
  type: "object",
  nullable: true,
  description: "null when this lead has no property association.",
  properties: {
    id: { type: "string", format: "uuid" },
    title: { type: "string" },
    status: { type: "string", enum: ["DRAFT", "ACTIVE", "INACTIVE"] },
  },
  required: ["id", "title", "status"],
} as const;

export const leadSchema = {
  $id: "Lead",
  title: "Lead",
  type: "object",
  description: "A lead as persisted in the tenant's own database. Never carries a tenant id.",
  properties: {
    id: { type: "string", format: "uuid" },
    property_id: { type: "string", format: "uuid", nullable: true },
    name: { type: "string" },
    email: { type: "string", nullable: true },
    phone: { type: "string", nullable: true },
    status: { type: "string", enum: [...LEAD_STATUSES] },
    source: { type: "string", enum: [...LEAD_SOURCES] },
    message: { type: "string", nullable: true },
    notes: { type: "string", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "property_id",
    "name",
    "email",
    "phone",
    "status",
    "source",
    "message",
    "notes",
    "created_at",
    "updated_at",
  ],
  examples: [EXAMPLE_LEAD],
} as const;

/**
 * `GET /api/v1/leads` and `GET /api/v1/leads/:id` response item only (Prompt 043, sections 42/
 * 46) — `Lead`'s own fields plus a summarized `property`. Never used for the create/update
 * responses, which never carry `property` (same asymmetry `PropertyListItem`/`cover` already
 * established for Properties — this task inverts *which* endpoints get the summary, but keeps
 * the same "create/update responses stay minimal" principle).
 */
export const leadWithPropertySchema = {
  $id: "LeadWithProperty",
  title: "LeadWithProperty",
  type: "object",
  properties: {
    ...leadSchema.properties,
    property: LEAD_PROPERTY_SUMMARY_PROPERTY,
  },
  required: [...leadSchema.required, "property"],
  examples: [
    {
      ...EXAMPLE_LEAD,
      property: { id: EXAMPLE_LEAD.property_id, title: "Apartamento no Centro", status: "ACTIVE" },
    },
  ],
} as const;

export const leadListSchema = {
  $id: "LeadList",
  title: "LeadList",
  type: "object",
  properties: {
    data: { type: "array", items: { $ref: "LeadWithProperty#" } },
    pagination: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
        total: { type: "integer", minimum: 0 },
        total_pages: { type: "integer", minimum: 0 },
      },
      required: ["page", "limit", "total", "total_pages"],
    },
  },
  required: ["data", "pagination"],
  examples: [
    {
      data: [
        {
          ...EXAMPLE_LEAD,
          property: { id: EXAMPLE_LEAD.property_id, title: "Apartamento no Centro", status: "ACTIVE" },
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, total_pages: 1 },
    },
  ],
} as const;
