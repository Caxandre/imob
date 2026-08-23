import { z } from "zod";

export const NAME_MAX_LENGTH = 120;
export const SLUG_MIN_LENGTH = 3;
// 63 is PostgreSQL's identifier limit; the slug is expected to inform tenant database naming.
export const SLUG_MAX_LENGTH = 63;

// Lowercase alphanumeric groups joined by single hyphens: rejects leading/trailing hyphens,
// consecutive hyphens, underscores, spaces and accented characters.
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Authoritative validation for the create-tenant payload. Normalization runs before the
 * format checks, so "  EMPRESA-EXEMPLO  " is accepted and stored as "empresa-exemplo".
 */
export const createTenantBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "name must not be empty")
    .max(NAME_MAX_LENGTH, `name must be at most ${NAME_MAX_LENGTH} characters`),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(SLUG_MIN_LENGTH, `slug must be at least ${SLUG_MIN_LENGTH} characters`)
    .max(SLUG_MAX_LENGTH, `slug must be at most ${SLUG_MAX_LENGTH} characters`)
    .regex(
      SLUG_PATTERN,
      "slug must contain only lowercase letters, digits and single hyphens between them",
    ),
});

export type CreateTenantBody = z.infer<typeof createTenantBodySchema>;
