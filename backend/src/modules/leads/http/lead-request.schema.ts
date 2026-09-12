import { z } from "zod";

import { UUID_PATTERN } from "../../properties/http/property-request.schema.js";

export const NAME_MAX_LENGTH = 120;
export const EMAIL_MAX_LENGTH = 254;
export const PHONE_MAX_LENGTH = 30;
export const MESSAGE_MAX_LENGTH = 2000;
export const NOTES_MAX_LENGTH = 2000;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
export const Q_MIN_LENGTH = 2;
export const Q_MAX_LENGTH = 120;

export const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "WON", "LOST"] as const;
export const LEAD_SOURCES = ["MANUAL", "WEBSITE", "WHATSAPP", "PORTAL", "OTHER"] as const;

/** Allowlist for `GET /api/v1/leads?sort=` (Prompt 043, section 39) — mirrors `LeadSort` in
 * `lead-repository.ts` (application layer) manually, the same domain/http duplication already
 * established for Properties' own sort fields/enums. */
export const LEAD_SORT_FIELDS = ["created_at", "updated_at", "name", "status"] as const;
export const SORT_ORDERS = ["asc", "desc"] as const;

// Conservative, shallow validation (Prompt 043, section 13) — digits and standard phone
// punctuation only, never an attempt to parse/normalize DDI/DDD or install an international
// phone number library for this foundation.
const PHONE_PATTERN = /^[0-9+()\-.\s]+$/;

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH, `email must be at most ${EMAIL_MAX_LENGTH} characters`)
  .pipe(z.email("email must be a valid email address"));

const phoneSchema = z
  .string()
  .trim()
  .min(1, "phone must not be empty")
  .max(PHONE_MAX_LENGTH, `phone must be at most ${PHONE_MAX_LENGTH} characters`)
  .regex(PHONE_PATTERN, "phone must contain only digits and standard phone punctuation");

function optionalEmail() {
  return emailSchema.nullish().transform((value) => value ?? null);
}

function optionalPhone() {
  return phoneSchema.nullish().transform((value) => value ?? null);
}

function optionalUuid(fieldName: string) {
  return z
    .string()
    .trim()
    .regex(UUID_PATTERN, `${fieldName} must be a valid UUID`)
    .nullish()
    .transform((value) => value ?? null);
}

function optionalText(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .nullish()
    .transform((value) => value ?? null);
}

/**
 * Update-only variants, deliberately distinct from the `optional*` helpers above — same
 * "reusing the create schema with a blind `.partial()` would collapse omitted-vs-null" reasoning
 * already documented on Properties' `optionalNullableTrimmedString`. PATCH semantics require
 * telling the two apart: a key absent from the parsed object means "leave unchanged"; a key
 * present with `null` means "clear it".
 */
function patchOptionalEmail() {
  return emailSchema.nullable().optional();
}

function patchOptionalPhone() {
  return phoneSchema.nullable().optional();
}

function patchOptionalUuid(fieldName: string) {
  return z.string().trim().regex(UUID_PATTERN, `${fieldName} must be a valid UUID`).nullable().optional();
}

function patchOptionalText(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).nullable().optional();
}

/**
 * Authoritative validation for the create-lead request body (Prompt 043, sections 11-17/26).
 * `status` is deliberately never part of this shape (`.strict()` rejects it if sent) — a new
 * lead is always `NEW`, decided entirely server-side (section 15). `.refine()` enforces the one
 * cross-field invariant a create payload can fully validate on its own: at least one contact
 * channel present (section 14) — the equivalent check on PATCH needs the lead's *existing* state
 * too, so it lives in the application layer instead (`update-lead.ts`), never here.
 */
export const createLeadBodySchema = z
  .object({
    name: z.string().trim().min(1, "name must not be empty").max(NAME_MAX_LENGTH),
    email: optionalEmail(),
    phone: optionalPhone(),
    property_id: optionalUuid("property_id"),
    source: z.enum(LEAD_SOURCES).default("MANUAL"),
    message: optionalText(MESSAGE_MAX_LENGTH),
    notes: optionalText(NOTES_MAX_LENGTH),
  })
  .strict()
  .refine((body) => body.email !== null || body.phone !== null, {
    message: "at least one contact channel (email or phone) is required",
    path: ["email"],
  });

export type CreateLeadBody = z.infer<typeof createLeadBodySchema>;

/**
 * Authoritative validation for `GET /api/v1/leads` — structured filters (Prompt 043, section 33)
 * plus `sort`/`order`, all optional and AND-combined. `.strict()` rejects any query param
 * outside this shape with 400 (section 40), same convention as `listPropertiesQuerySchema`.
 */
export const listLeadsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
    status: z.enum(LEAD_STATUSES).optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    property_id: z.string().trim().regex(UUID_PATTERN, "property_id must be a valid UUID").optional(),
    created_from: z.iso.datetime({ offset: true }).optional(),
    created_to: z.iso.datetime({ offset: true }).optional(),
    q: z
      .string()
      .trim()
      .min(Q_MIN_LENGTH, `q must be at least ${Q_MIN_LENGTH} characters`)
      .max(Q_MAX_LENGTH, `q must be at most ${Q_MAX_LENGTH} characters`)
      .optional(),
    sort: z.enum(LEAD_SORT_FIELDS).default("created_at"),
    order: z.enum(SORT_ORDERS).default("desc"),
  })
  .strict()
  .refine(
    (query) =>
      query.created_from === undefined ||
      query.created_to === undefined ||
      new Date(query.created_from).getTime() <= new Date(query.created_to).getTime(),
    { message: "created_from must be less than or equal to created_to", path: ["created_from"] },
  );

export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

// Reused by every `:id` route (Prompt 043, section 45) — one canonical UUID params shape,
// never duplicated.
export const leadIdParamsSchema = z.object({
  id: z.string().trim().regex(UUID_PATTERN, "id must be a valid UUID"),
});

export type LeadIdParams = z.infer<typeof leadIdParamsSchema>;

/**
 * Authoritative validation for the update-lead (PATCH) request body (Prompt 043, section 47).
 * `.strict()` rejects any key outside this shape — including `id`/`created_at`/`updated_at`,
 * simply never part of it — and the `.refine()` below rejects an empty body, same convention as
 * `updatePropertyBodySchema`. The contact-channel invariant is deliberately **not** re-checked
 * here (section 48/49): this schema only knows the partial payload, never the lead's current
 * persisted state, so that check happens in `update-lead.ts` against the resulting merged state.
 */
export const updateLeadBodySchema = z
  .object({
    name: z.string().trim().min(1, "name must not be empty").max(NAME_MAX_LENGTH).optional(),
    email: patchOptionalEmail(),
    phone: patchOptionalPhone(),
    property_id: patchOptionalUuid("property_id"),
    status: z.enum(LEAD_STATUSES).optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    message: patchOptionalText(MESSAGE_MAX_LENGTH),
    notes: patchOptionalText(NOTES_MAX_LENGTH),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "at least one field must be provided" });

export type UpdateLeadBody = z.infer<typeof updateLeadBodySchema>;
