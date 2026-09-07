import { z } from "zod";

import { propertyStatusSchema, propertyTypeSchema, transactionTypeSchema } from "./property.schema";

/**
 * URL query parameter names and validation rules, verified against the backend's
 * `listPropertiesQuerySchema` (`backend/src/modules/properties/http/property-request.schema.ts`)
 * rather than the prompt's own (slightly different) example list — notably the backend uses
 * `sort` + `order` (not `sort` + `direction`), and the only page-size param is `limit`.
 */
export const PROPERTY_SORT_FIELDS = [
  "created_at",
  "updated_at",
  "price",
  "area_m2",
  "bedrooms",
] as const;
export const propertySortFieldSchema = z.enum(PROPERTY_SORT_FIELDS);
export type PropertySortField = z.infer<typeof propertySortFieldSchema>;

export const SORT_ORDERS = ["asc", "desc"] as const;
export const sortOrderSchema = z.enum(SORT_ORDERS);
export type SortOrder = z.infer<typeof sortOrderSchema>;

// Matches the backend's `positiveDecimalString` (price_min/price_max/area_min/area_max).
const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/)
  .refine((value) => Number(value) > 0);

const nonNegativeIntSchema = z.coerce.number().int().min(0);

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

/**
 * Lenient, per-field schema (section 35): an invalid value for one field never invalidates the
 * whole object — it is silently dropped (`.catch(undefined)`) so a tampered/stale URL (or a
 * partially-filled form) degrades to "filter not applied" instead of breaking the page. Shared
 * between URL parsing and the filter form's submit normalization (see `parsePropertyFilters`
 * and `PropertyFilterForm`) — there is exactly one definition of "what counts as a valid filter
 * value".
 */
export const propertyFiltersSchema = z.object({
  q: z.preprocess(emptyToUndefined, z.string().trim().min(2).max(120).optional().catch(undefined)),
  status: z.preprocess(emptyToUndefined, propertyStatusSchema.optional().catch(undefined)),
  property_type: z.preprocess(emptyToUndefined, propertyTypeSchema.optional().catch(undefined)),
  transaction_type: z.preprocess(
    emptyToUndefined,
    transactionTypeSchema.optional().catch(undefined),
  ),
  city: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).max(200).optional().catch(undefined),
  ),
  state: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .optional()
      .catch(undefined),
  ),
  price_min: z.preprocess(emptyToUndefined, decimalStringSchema.optional().catch(undefined)),
  price_max: z.preprocess(emptyToUndefined, decimalStringSchema.optional().catch(undefined)),
  bedrooms_min: z.preprocess(emptyToUndefined, nonNegativeIntSchema.optional().catch(undefined)),
  bathrooms_min: z.preprocess(emptyToUndefined, nonNegativeIntSchema.optional().catch(undefined)),
  parking_spaces_min: z.preprocess(
    emptyToUndefined,
    nonNegativeIntSchema.optional().catch(undefined),
  ),
  area_min: z.preprocess(emptyToUndefined, decimalStringSchema.optional().catch(undefined)),
  area_max: z.preprocess(emptyToUndefined, decimalStringSchema.optional().catch(undefined)),
  sort: z.preprocess(emptyToUndefined, propertySortFieldSchema.optional().catch(undefined)),
  order: z.preprocess(emptyToUndefined, sortOrderSchema.optional().catch(undefined)),
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).optional().catch(undefined)),
});
export type PropertyFilters = z.infer<typeof propertyFiltersSchema>;

const FILTER_KEYS: (keyof PropertyFilters)[] = [
  "q",
  "status",
  "property_type",
  "transaction_type",
  "city",
  "state",
  "price_min",
  "price_max",
  "bedrooms_min",
  "bathrooms_min",
  "parking_spaces_min",
  "area_min",
  "area_max",
];

const PARAM_ORDER: (keyof PropertyFilters)[] = [...FILTER_KEYS, "sort", "order"];

/**
 * Parses filters straight out of `URLSearchParams` (section 35) — invalid values (`page=-1`,
 * `price_min=abc`, `status=banana`) are dropped rather than thrown, so an edited/stale/shared URL
 * never breaks the page.
 */
export function parsePropertyFilters(searchParams: URLSearchParams): PropertyFilters {
  const raw = Object.fromEntries(searchParams.entries());
  return propertyFiltersSchema.parse(raw);
}

/**
 * Serializes filters back into `URLSearchParams` (sections 36-37): empty/undefined params are
 * omitted entirely, and `page` is omitted whenever it's the default (1 or unset) to keep the URL
 * clean rather than forcing `?page=1` onto every link.
 */
export function serializePropertyFilters(filters: PropertyFilters): URLSearchParams {
  const params = new URLSearchParams();

  for (const key of PARAM_ORDER) {
    const value = filters[key];
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }

  if (filters.page !== undefined && filters.page > 1) {
    params.set("page", String(filters.page));
  }

  return params;
}

// Deliberately excludes `sort`/`order`/`page` — those narrow presentation, not the result set, so
// they don't count as an "active filter" for empty-state messaging purposes.
export function hasActiveFilters(filters: PropertyFilters): boolean {
  return FILTER_KEYS.some((key) => filters[key] !== undefined);
}
