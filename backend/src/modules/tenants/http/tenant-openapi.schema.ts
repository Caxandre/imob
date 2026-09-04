import { NAME_MAX_LENGTH, SLUG_MAX_LENGTH, SLUG_MIN_LENGTH } from "./create-tenant.schema.js";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, TENANT_STATUSES } from "./list-tenants.schema.js";

/**
 * OpenAPI/Fastify JSON Schema for the create-tenant request body. Deliberately loose on
 * length/pattern, on purpose — see `tenant-routes.ts`: `createTenantBodySchema` (Zod)
 * validates the value *after* trimming/lowercasing it, and raw JSON Schema has no way to
 * express "validate this after normalizing it" against the untransformed payload. Encoding
 * `minLength`/`pattern` here would apply them to the raw body via Fastify's built-in AJV
 * validation, which runs *before* the handler and its Zod check — that would reject some
 * inputs Zod would accept (e.g. a name only over budget before trimming) and, on rejection,
 * return a generic AJV-shaped error instead of this API's own `{statusCode, error, message,
 * details}` envelope. The length/pattern rules are still derived from the exact same
 * exported constants Zod uses — as description text, the only place they can safely live
 * without duplicating (and risking diverging from) the real validation logic.
 */
export const createTenantRequestSchema = {
  $id: "CreateTenantRequest",
  title: "CreateTenantRequest",
  type: "object",
  properties: {
    name: {
      type: "string",
      description: `Display name. Trimmed; must not be empty and must be at most ${NAME_MAX_LENGTH} characters after trimming.`,
    },
    slug: {
      type: "string",
      description: `Public identifier. Trimmed and lowercased, then must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be between ${SLUG_MIN_LENGTH} and ${SLUG_MAX_LENGTH} characters.`,
    },
  },
  required: ["name", "slug"],
  examples: [{ name: "Imobiliária Central", slug: "imobiliaria-central" }],
} as const;

/**
 * The tenant as returned right after creation. `status` is narrowed to `PROVISIONING` only —
 * the one value `POST /tenants` can ever actually return, per `createTenant()`'s own
 * contract (no provisioning happens synchronously within the request). A future endpoint
 * that returns a tenant in any other state would need its own response schema, not a looser
 * version of this one.
 */
export const tenantSchema = {
  $id: "Tenant",
  title: "Tenant",
  type: "object",
  description: "A tenant as returned immediately after creation.",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    slug: { type: "string" },
    status: { type: "string", enum: ["PROVISIONING"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "name", "slug", "status", "createdAt", "updatedAt"],
  examples: [
    {
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      name: "Imobiliária Central",
      slug: "imobiliaria-central",
      status: "PROVISIONING",
      createdAt: "2026-08-27T12:00:00.000Z",
      updatedAt: "2026-08-27T12:00:00.000Z",
    },
  ],
} as const;

const EXAMPLE_TENANT_LIST_ITEM = {
  id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  name: "Imobiliária Central",
  slug: "imobiliaria-central",
  status: "READY",
  createdAt: "2026-09-03T12:00:00.000Z",
  updatedAt: "2026-09-03T12:05:00.000Z",
  database: {
    status: "READY",
    databaseName: "tenant_imobiliaria_central",
    schemaVersion: 7,
    cluster: {
      id: "9c3b1f6e-2a8c-4d9f-9e3b-2d1a5c8f0e11",
      name: "local-tenants",
      provider: "local",
      region: "local",
      status: "ACTIVE",
    },
  },
} as const;

/**
 * One item of `GET /api/v1/tenants` (Prompt 033). `database`/`cluster` are `null` — never an
 * artificial/synthesized object — exactly when no `tenant_databases`/`database_clusters` row
 * could be resolved for this tenant (this task, sections 15/16). Never includes
 * `secret_reference`, a password, or any other credential (section 13) — `databaseName` is a
 * technical identifier, not a secret (section 17).
 */
export const tenantListItemSchema = {
  $id: "TenantListItem",
  title: "TenantListItem",
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    slug: { type: "string" },
    status: { type: "string", enum: [...TENANT_STATUSES] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    database: {
      type: "object",
      nullable: true,
      description: "null when this tenant has no tenant_databases row yet.",
      properties: {
        status: { type: "string", enum: ["PROVISIONING", "READY", "FAILED"] },
        databaseName: { type: "string" },
        schemaVersion: { type: "integer", minimum: 0 },
        cluster: {
          type: "object",
          nullable: true,
          description: "null only if the registered cluster could not be resolved.",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            provider: { type: "string" },
            region: { type: "string" },
            status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
          },
          required: ["id", "name", "provider", "region", "status"],
        },
      },
      required: ["status", "databaseName", "schemaVersion", "cluster"],
    },
  },
  required: ["id", "name", "slug", "status", "createdAt", "updatedAt", "database"],
  examples: [EXAMPLE_TENANT_LIST_ITEM],
} as const;

export const tenantListSchema = {
  $id: "TenantList",
  title: "TenantList",
  type: "object",
  description:
    "Administrative listing of tenants in the Control Plane (never the Tenant Data Plane), " +
    "joined with a summary of each tenant's database/cluster when available.",
  properties: {
    data: { type: "array", items: { $ref: "TenantListItem#" } },
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
      data: [EXAMPLE_TENANT_LIST_ITEM],
      pagination: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 1, total_pages: 1 },
    },
  ],
} as const;
