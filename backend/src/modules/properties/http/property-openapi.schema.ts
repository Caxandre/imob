import {
  ADDRESS_FIELD_MAX_LENGTH,
  DEFAULT_PAGE_LIMIT,
  DESCRIPTION_MAX_LENGTH,
  MAX_PAGE_LIMIT,
  NUMBER_MAX_LENGTH,
  POSTAL_CODE_MAX_LENGTH,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  TITLE_MAX_LENGTH,
  TRANSACTION_TYPES,
} from "./property-request.schema.js";

/**
 * Documented on every Properties route (this task, section 38). Temporary — see
 * `src/app/tenant-context.ts`: not authentication, only development/integration scaffolding
 * until real tenant authentication exists.
 */
export const tenantIdHeaderSchema = {
  type: "object",
  properties: {
    "x-tenant-id": {
      type: "string",
      format: "uuid",
      description:
        "Temporary tenant context for development until authentication is implemented. " +
        "Identifies which tenant's database this request operates against. This header is " +
        "NOT authentication — any client that knows a tenantId can set it.",
    },
  },
  required: ["x-tenant-id"],
} as const;

const EXAMPLE_PROPERTY = {
  id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  title: "Apartamento no Centro",
  description: "Apartamento com boa localização.",
  property_type: "APARTMENT",
  transaction_type: "SALE",
  status: "DRAFT",
  price: "450000.00",
  bedrooms: 3,
  bathrooms: 2,
  parking_spaces: 1,
  area_m2: "92.50",
  street: "Rua Exemplo",
  number: "123",
  complement: null,
  neighborhood: "Centro",
  city: "São Paulo",
  state: "SP",
  postal_code: "01000-000",
  created_at: "2026-08-27T12:00:00.000Z",
  updated_at: "2026-08-27T12:00:00.000Z",
} as const;

/**
 * `price`/`area_m2` are documented as `string`, never `number` — this task's explicit money
 * contract decision (section 23): a JSON number cannot round-trip arbitrary-precision decimals
 * safely in JavaScript, so both travel as decimal strings, e.g. `"450000.00"`.
 *
 * Deliberately loose on `enum`/`minimum`/`maxLength` — same reasoning as
 * `tenant-openapi.schema.ts`'s `CreateTenantRequest`: `createPropertyBodySchema` (Zod)
 * validates the value *after* trimming/coercing it, and Fastify's built-in AJV validation runs
 * against the raw body *before* the handler and its Zod check ever run. Encoding real
 * constraints here would let AJV reject some inputs before Zod even sees them, returning a
 * generic AJV-shaped error instead of this API's own `{statusCode, error, message, details}`
 * envelope — including `required`, deliberately omitted here too, so a payload missing a
 * required field still gets Zod's own structured `details`, not AJV's.
 */
export const createPropertyRequestSchema = {
  $id: "CreatePropertyRequest",
  title: "CreatePropertyRequest",
  type: "object",
  properties: {
    title: { type: "string", description: `Trimmed; required, at most ${TITLE_MAX_LENGTH} characters.` },
    description: { type: "string", nullable: true, description: `Trimmed; at most ${DESCRIPTION_MAX_LENGTH} characters.` },
    property_type: { type: "string", description: `One of: ${PROPERTY_TYPES.join(", ")}.` },
    transaction_type: { type: "string", description: `One of: ${TRANSACTION_TYPES.join(", ")}.` },
    status: { type: "string", description: `One of: ${PROPERTY_STATUSES.join(", ")}. Defaults to DRAFT.` },
    price: {
      type: "string",
      description: "Decimal string with up to 2 decimal places, greater than 0 (e.g. \"450000.00\").",
    },
    bedrooms: { type: "integer", nullable: true, description: "Must be >= 0 when present." },
    bathrooms: { type: "integer", nullable: true, description: "Must be >= 0 when present." },
    parking_spaces: { type: "integer", nullable: true, description: "Must be >= 0 when present." },
    area_m2: {
      type: "string",
      nullable: true,
      description: "Decimal string with up to 2 decimal places, greater than 0 (e.g. \"92.50\").",
    },
    street: { type: "string", nullable: true, description: `At most ${ADDRESS_FIELD_MAX_LENGTH} characters.` },
    number: { type: "string", nullable: true, description: `At most ${NUMBER_MAX_LENGTH} characters.` },
    complement: { type: "string", nullable: true, description: `At most ${ADDRESS_FIELD_MAX_LENGTH} characters.` },
    neighborhood: { type: "string", nullable: true, description: `At most ${ADDRESS_FIELD_MAX_LENGTH} characters.` },
    city: { type: "string", nullable: true, description: `At most ${ADDRESS_FIELD_MAX_LENGTH} characters.` },
    state: { type: "string", nullable: true, description: "Brazilian UF, 2 letters (e.g. \"SP\")." },
    postal_code: { type: "string", nullable: true, description: `At most ${POSTAL_CODE_MAX_LENGTH} characters.` },
  },
  examples: [
    {
      title: "Apartamento no Centro",
      description: "Apartamento com boa localização.",
      property_type: "APARTMENT",
      transaction_type: "SALE",
      status: "DRAFT",
      price: "450000.00",
      bedrooms: 3,
      bathrooms: 2,
      parking_spaces: 1,
      area_m2: "92.50",
      street: "Rua Exemplo",
      number: "123",
      neighborhood: "Centro",
      city: "São Paulo",
      state: "SP",
      postal_code: "01000-000",
    },
  ],
} as const;

/**
 * Deliberately NOT `createPropertyRequestSchema` reused/relaxed — same reasoning as
 * `updatePropertyBodySchema` (Zod): every field here is genuinely optional (a PATCH may send
 * any subset), and this JSON Schema stays loose for the same AJV-runs-before-Zod reason
 * documented on `CreatePropertyRequest` above — no `required`, no `enum`/`minimum`/`maxLength`
 * enforced here either. `id`/`created_at`/`updated_at` are never listed — they are immutable
 * and Zod's `.strict()` already rejects them if sent.
 */
export const updatePropertyRequestSchema = {
  $id: "UpdatePropertyRequest",
  title: "UpdatePropertyRequest",
  type: "object",
  description: "Any subset of the editable property fields. At least one must be present.",
  properties: {
    title: { type: "string", description: `Trimmed; at most ${TITLE_MAX_LENGTH} characters.` },
    description: { type: "string", nullable: true, description: "Send null to clear it." },
    property_type: { type: "string", description: `One of: ${PROPERTY_TYPES.join(", ")}.` },
    transaction_type: { type: "string", description: `One of: ${TRANSACTION_TYPES.join(", ")}.` },
    status: { type: "string", description: `One of: ${PROPERTY_STATUSES.join(", ")}.` },
    price: {
      type: "string",
      description: "Decimal string with up to 2 decimal places, greater than 0 (e.g. \"475000.00\").",
    },
    bedrooms: { type: "integer", nullable: true, description: "Must be >= 0 when present. Send null to clear it." },
    bathrooms: { type: "integer", nullable: true, description: "Must be >= 0 when present. Send null to clear it." },
    parking_spaces: {
      type: "integer",
      nullable: true,
      description: "Must be >= 0 when present. Send null to clear it.",
    },
    area_m2: {
      type: "string",
      nullable: true,
      description: "Decimal string with up to 2 decimal places, greater than 0. Send null to clear it.",
    },
    street: { type: "string", nullable: true, description: "Send null to clear it." },
    number: { type: "string", nullable: true, description: "Send null to clear it." },
    complement: { type: "string", nullable: true, description: "Send null to clear it." },
    neighborhood: { type: "string", nullable: true, description: "Send null to clear it." },
    city: { type: "string", nullable: true, description: "Send null to clear it." },
    state: { type: "string", nullable: true, description: "Brazilian UF, 2 letters. Send null to clear it." },
    postal_code: { type: "string", nullable: true, description: "Send null to clear it." },
  },
  examples: [{ price: "475000.00", status: "ACTIVE" }],
} as const;

export const propertySchema = {
  $id: "Property",
  title: "Property",
  type: "object",
  description: "A property as persisted in the tenant's own database. Never carries a tenant id.",
  properties: {
    id: { type: "string", format: "uuid" },
    title: { type: "string" },
    description: { type: "string", nullable: true },
    property_type: { type: "string", enum: [...PROPERTY_TYPES] },
    transaction_type: { type: "string", enum: [...TRANSACTION_TYPES] },
    status: { type: "string", enum: [...PROPERTY_STATUSES] },
    price: { type: "string" },
    bedrooms: { type: "integer", nullable: true },
    bathrooms: { type: "integer", nullable: true },
    parking_spaces: { type: "integer", nullable: true },
    area_m2: { type: "string", nullable: true },
    street: { type: "string", nullable: true },
    number: { type: "string", nullable: true },
    complement: { type: "string", nullable: true },
    neighborhood: { type: "string", nullable: true },
    city: { type: "string", nullable: true },
    state: { type: "string", nullable: true },
    postal_code: { type: "string", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "title",
    "property_type",
    "transaction_type",
    "status",
    "price",
    "created_at",
    "updated_at",
  ],
  examples: [EXAMPLE_PROPERTY],
} as const;

export const propertyListSchema = {
  $id: "PropertyList",
  title: "PropertyList",
  type: "object",
  properties: {
    data: { type: "array", items: { $ref: "Property#" } },
    pagination: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
        total: { type: "integer", minimum: 0 },
        total_pages: { type: "integer", minimum: 0 },
      },
      required: ["page", "limit", "total", "total_pages"],
    },
  },
  required: ["data", "pagination"],
  examples: [
    {
      data: [EXAMPLE_PROPERTY],
      pagination: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 1, total_pages: 1 },
    },
  ],
} as const;
