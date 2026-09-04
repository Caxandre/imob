import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
export const Q_MIN_LENGTH = 1;
export const Q_MAX_LENGTH = 120;

// Mirrors `TenantStatus` in `domain/tenant.ts` manually — the same domain/http duplication
// already used for `PROPERTY_STATUSES` etc. in `property-request.schema.ts`.
export const TENANT_STATUSES = ["PROVISIONING", "READY", "FAILED", "SUSPENDED"] as const;

/**
 * Authoritative validation for `GET /api/v1/tenants` (Prompt 033). `.strict()` rejects any
 * query param outside this shape with 400 (this task, section 27/50), the same convention
 * already used by `listPropertiesQuerySchema`. `q` is trimmed and length-bounded here — an
 * empty-after-trim value fails `.min()` and is rejected with 400, deliberately never treated as
 * "absent" (this task, section 8: an explicit empty `q` is a client error, not silently
 * ignored) — same rule Properties already applies to its own `q`.
 */
export const listTenantsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
    status: z.enum(TENANT_STATUSES).optional(),
    q: z
      .string()
      .trim()
      .min(Q_MIN_LENGTH, `q must be at least ${Q_MIN_LENGTH} character`)
      .max(Q_MAX_LENGTH, `q must be at most ${Q_MAX_LENGTH} characters`)
      .optional(),
  })
  .strict();

export type ListTenantsQuery = z.infer<typeof listTenantsQuerySchema>;
