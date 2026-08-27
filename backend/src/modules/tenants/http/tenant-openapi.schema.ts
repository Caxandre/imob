import { NAME_MAX_LENGTH, SLUG_MAX_LENGTH, SLUG_MIN_LENGTH } from "./create-tenant.schema.js";

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
