import { ALLOWED_PROPERTY_MEDIA_MIME_TYPES } from "../domain/property-media.js";
import { MAX_MEDIA_FILE_SIZE_BYTES } from "./property-media-request.schema.js";
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

const EXAMPLE_PROPERTY_MEDIA_VARIANT = {
  url: "https://public-base.example/tenants/.../properties/.../3b1f6e2a.../thumbnail.webp",
  mime_type: "image/webp",
  width: 320,
  height: 213,
  size_bytes: 12_345,
} as const;

/**
 * One processed rendition (Prompt 035) — `null` when this slot has no
 * `property_media_variants` row yet (section 7/8/9: `PROCESSING`, `FAILED`, or a "legacy READY"
 * media from before Prompt 032's worker ever ran). Deliberately excludes `id`/
 * `property_media_id`/`object_key`/`created_at`/`updated_at` (section 11) — a public rendition
 * DTO, never a row dump. `url` (not `public_url`, section 12) distinguishes a variant's own URL
 * from the original media's `public_url` at the top level. `mime_type` is whatever the worker
 * actually persisted (currently always `image/webp`, ADR-008) — never hardcoded here (section
 * 27).
 */
const VARIANT_PROPERTY = {
  type: "object",
  nullable: true,
  properties: {
    url: { type: "string", format: "uri" },
    mime_type: { type: "string" },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    size_bytes: { type: "integer", minimum: 1 },
  },
  required: ["url", "mime_type", "width", "height", "size_bytes"],
} as const;

const EXAMPLE_PROPERTY_MEDIA = {
  id: "3b1f6e2a-8c9d-4f7a-9e3b-2d1a5c8f0e11",
  property_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  public_url: "https://public-base.example/tenants/.../properties/.../3b1f6e2a....jpg",
  mime_type: "image/jpeg",
  size_bytes: 245_760,
  original_filename: "foto-sala.jpg",
  position: 0,
  is_cover: true,
  processing_status: "READY",
  created_at: "2026-08-28T12:00:00.000Z",
  updated_at: "2026-08-28T12:00:00.000Z",
  variants: {
    thumbnail: EXAMPLE_PROPERTY_MEDIA_VARIANT,
    card: {
      url: "https://public-base.example/tenants/.../properties/.../3b1f6e2a.../card.webp",
      mime_type: "image/webp",
      width: 640,
      height: 426,
      size_bytes: 23_456,
    },
    detail: {
      url: "https://public-base.example/tenants/.../properties/.../3b1f6e2a.../detail.webp",
      mime_type: "image/webp",
      width: 1280,
      height: 853,
      size_bytes: 45_678,
    },
  },
} as const;

/**
 * Deliberately never includes `object_key` (this task, section 44) — it is an internal storage
 * detail, not part of the public contract. `public_url` is the persisted value from the upload
 * (`ObjectStorage.putObject()`), never recomputed on read (section 8). `is_cover` (Prompt 028):
 * at most one `true` per property, enforced by a database partial unique index — never only an
 * application convention. `variants` (Prompt 035) always carries exactly the three fixed keys
 * `thumbnail`/`card`/`detail` — never a generic array (section 6) — each independently
 * `null`able (section 7/8/9); never a fallback to the original's own `public_url` (section 10),
 * and never `variants.original` (section 64).
 */
export const propertyMediaSchema = {
  $id: "PropertyMedia",
  title: "PropertyMedia",
  type: "object",
  description: "A property media (photo) as persisted in the tenant's own database. Never carries a tenant id.",
  properties: {
    id: { type: "string", format: "uuid" },
    property_id: { type: "string", format: "uuid" },
    public_url: { type: "string", format: "uri" },
    mime_type: { type: "string", enum: [...ALLOWED_PROPERTY_MEDIA_MIME_TYPES] },
    size_bytes: { type: "integer", minimum: 1 },
    original_filename: { type: "string", nullable: true },
    position: { type: "integer", minimum: 0 },
    is_cover: { type: "boolean", description: "At most one media per property has this set to true." },
    processing_status: {
      type: "string",
      enum: ["PROCESSING", "READY", "FAILED"],
      description:
        "Lifecycle of this media's derived variants (thumbnail/card/detail) — never about the " +
        "original itself, which is already usable via public_url in every state. New uploads " +
        "start PROCESSING and converge to READY (all three variants present) or FAILED (all " +
        "three null) via the media processing worker (ADR-008). A 'legacy READY' media — " +
        "migrated by the Prompt 030 backfill before any worker ever ran — may still have some " +
        "or all variants null despite being READY; the variants object always reflects exactly " +
        "what exists, never an assumption based on processing_status alone.",
    },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    variants: {
      type: "object",
      description:
        "Always present with exactly these three keys. Each is null until that variant has " +
        "been generated (or if generation permanently failed).",
      properties: {
        thumbnail: VARIANT_PROPERTY,
        card: VARIANT_PROPERTY,
        detail: VARIANT_PROPERTY,
      },
      required: ["thumbnail", "card", "detail"],
    },
  },
  required: [
    "id",
    "property_id",
    "public_url",
    "mime_type",
    "size_bytes",
    "original_filename",
    "position",
    "is_cover",
    "processing_status",
    "created_at",
    "updated_at",
    "variants",
  ],
  examples: [EXAMPLE_PROPERTY_MEDIA],
} as const;

export const propertyMediaListSchema = {
  $id: "PropertyMediaList",
  title: "PropertyMediaList",
  type: "object",
  properties: {
    data: { type: "array", items: { $ref: "PropertyMedia#" } },
  },
  required: ["data"],
  examples: [{ data: [EXAMPLE_PROPERTY_MEDIA] }],
} as const;

/**
 * `multipart/form-data` request body for `POST /api/v1/properties/{id}/media` — documented as
 * a plain JSON Schema description (this task, section 69: no base64 embedded here), the same
 * loose-on-purpose style already used for `CreatePropertyRequest`/`UpdatePropertyRequest`:
 * Fastify's built-in AJV validation runs before the handler's own multipart/magic-byte checks,
 * so encoding real constraints here would let AJV reject a request with its own generic error
 * shape instead of this API's `{statusCode, error, message, details}` envelope. The `file`
 * field itself is intentionally not schema-validated at all — `@fastify/multipart` parses it
 * before AJV body validation would even apply to a multipart request.
 */
export const uploadPropertyMediaRequestSchema = {
  $id: "UploadPropertyMediaRequest",
  title: "UploadPropertyMediaRequest",
  type: "object",
  description:
    `multipart/form-data with a single field named "file" (binary), at most ` +
    `${String(MAX_MEDIA_FILE_SIZE_BYTES / (1024 * 1024))}MB, one of: ` +
    `${ALLOWED_PROPERTY_MEDIA_MIME_TYPES.join(", ")}.`,
  properties: {
    file: { type: "string", format: "binary", description: "The image file." },
  },
} as const;

/**
 * `PUT /api/v1/properties/{id}/media/order` request body (Prompt 028, section 71). Loose on
 * purpose, same reasoning already documented on `CreatePropertyRequest`/
 * `UploadPropertyMediaRequest` above — `reorderPropertyMediaBodySchema` (Zod) is the real
 * validation; this stays undemanding so AJV never rejects a request before Zod's own
 * `{statusCode, error, message, details}` envelope gets a chance to run.
 */
export const reorderPropertyMediaRequestSchema = {
  $id: "ReorderPropertyMediaRequest",
  title: "ReorderPropertyMediaRequest",
  type: "object",
  description:
    "The complete new gallery order, as an array of every media id the property currently " +
    "has — media_ids[0] becomes position 0, media_ids[1] becomes position 1, and so on. Must " +
    "contain exactly the property's current media ids (no fewer, no more, no duplicates).",
  properties: {
    media_ids: { type: "array", items: { type: "string", format: "uuid" } },
  },
  examples: [
    {
      media_ids: [
        "3b1f6e2a-8c9d-4f7a-9e3b-2d1a5c8f0e11",
        "7c2e5a1b-4d6f-4a8c-b3e7-1f9a2d5c8e40",
      ],
    },
  ],
} as const;
