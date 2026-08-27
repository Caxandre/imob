import type { FastifyRequest } from "fastify";

const TENANT_ID_HEADER = "x-tenant-id";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Everything a domain route needs to know about which tenant a request is for.
 *
 * TEMPORARY MECHANISM (this task, Prompt 021): no authentication exists yet in this system.
 * `TenantContext` today is resolved purely from the `X-Tenant-Id` request header, which any
 * client that merely *knows* a tenant id can set — it proves nothing about who is making the
 * request. This is development/integration scaffolding, not a product decision: when real
 * authentication is built, only `resolveTenantContext()`'s implementation needs to change —
 * every route already depends on this interface, never on the header directly (section 4).
 * Never call anything derived from this "authenticated" or "authorized" (section 53) — those
 * concepts do not exist yet.
 */
export interface TenantContext {
  tenantId: string;
}

/** Raised when the `X-Tenant-Id` header is absent entirely. Maps to 400 — see `property-error-mapper.ts`. */
export class MissingTenantContextError extends Error {
  constructor() {
    super(`The "${TENANT_ID_HEADER}" header is required`);
    this.name = "MissingTenantContextError";
  }
}

/** Raised when `X-Tenant-Id` is present but not a syntactically valid UUID. Maps to 400. */
export class InvalidTenantContextError extends Error {
  constructor() {
    super(`The "${TENANT_ID_HEADER}" header must be a valid UUID`);
    this.name = "InvalidTenantContextError";
  }
}

/**
 * Resolves a `TenantContext` from the request. Encapsulated here so domain route handlers
 * never read `request.headers["x-tenant-id"]` directly (section 4) — swapping this for a real
 * authenticated tenant resolver later touches only this function. Validates presence and UUID
 * shape *before* anything else — no Control Plane/Tenant Data Plane lookup happens on this
 * path (section 5); resolving whether the tenant actually exists/is READY is
 * `TenantDatabaseResolver`'s job, called only after this succeeds.
 */
export function resolveTenantContext(request: FastifyRequest): TenantContext {
  const header = request.headers[TENANT_ID_HEADER];
  const value = Array.isArray(header) ? header[0] : header;

  if (!value) {
    throw new MissingTenantContextError();
  }
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidTenantContextError();
  }

  return { tenantId: value.toLowerCase() };
}
