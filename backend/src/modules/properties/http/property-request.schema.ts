import { z } from "zod";

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 5000;
export const ADDRESS_FIELD_MAX_LENGTH = 200;
export const NUMBER_MAX_LENGTH = 20;
export const POSTAL_CODE_MAX_LENGTH = 20;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const PROPERTY_TYPES = ["HOUSE", "APARTMENT", "LAND", "COMMERCIAL", "OTHER"] as const;
export const TRANSACTION_TYPES = ["SALE", "RENT"] as const;
export const PROPERTY_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Plain digits with an optional 2-decimal-place fraction — matches this schema's NUMERIC(*, 2)
// columns exactly, and deliberately rejects scientific notation or extra precision that a
// naive Number() parse would otherwise accept silently before truncation at the database.
const DECIMAL_STRING_PATTERN = /^\d+(\.\d{1,2})?$/;

function positiveDecimalString(fieldName: string) {
  return z
    .string()
    .trim()
    .regex(DECIMAL_STRING_PATTERN, `${fieldName} must be a decimal string with up to 2 decimal places`)
    .refine((value) => Number(value) > 0, `${fieldName} must be greater than 0`);
}

function optionalTrimmedString(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .nullish()
    .transform((value) => value ?? null);
}

function optionalNonNegativeInt() {
  return z
    .number()
    .int()
    .min(0)
    .nullish()
    .transform((value) => value ?? null);
}

/**
 * Authoritative validation for the create-property request body. Field names are snake_case
 * on the wire (matching this task's own example payload) and mapped to the module's camelCase
 * `CreatePropertyInput` shape explicitly in `property-routes.ts` — never silently renamed by a
 * generic transform.
 */
export const createPropertyBodySchema = z.object({
  title: z.string().trim().min(1, "title must not be empty").max(TITLE_MAX_LENGTH),
  description: optionalTrimmedString(DESCRIPTION_MAX_LENGTH),
  property_type: z.enum(PROPERTY_TYPES),
  transaction_type: z.enum(TRANSACTION_TYPES),
  status: z.enum(PROPERTY_STATUSES).default("DRAFT"),
  price: positiveDecimalString("price"),
  bedrooms: optionalNonNegativeInt(),
  bathrooms: optionalNonNegativeInt(),
  parking_spaces: optionalNonNegativeInt(),
  area_m2: positiveDecimalString("area_m2").nullish().transform((value) => value ?? null),
  street: optionalTrimmedString(ADDRESS_FIELD_MAX_LENGTH),
  number: optionalTrimmedString(NUMBER_MAX_LENGTH),
  complement: optionalTrimmedString(ADDRESS_FIELD_MAX_LENGTH),
  neighborhood: optionalTrimmedString(ADDRESS_FIELD_MAX_LENGTH),
  city: optionalTrimmedString(ADDRESS_FIELD_MAX_LENGTH),
  state: z
    .string()
    .trim()
    .length(2, "state must be a 2-letter Brazilian UF")
    .toUpperCase()
    .nullish()
    .transform((value) => value ?? null),
  postal_code: optionalTrimmedString(POSTAL_CODE_MAX_LENGTH),
});

export type CreatePropertyBody = z.infer<typeof createPropertyBodySchema>;

/** `page`/`limit` arrive as query string values (always strings) — coerced, then bounded. */
export const listPropertiesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export type ListPropertiesQuery = z.infer<typeof listPropertiesQuerySchema>;

export const propertyIdParamsSchema = z.object({
  id: z.string().trim().regex(UUID_PATTERN, "id must be a valid UUID"),
});

export type PropertyIdParams = z.infer<typeof propertyIdParamsSchema>;
