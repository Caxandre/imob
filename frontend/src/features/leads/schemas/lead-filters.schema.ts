import { z } from "zod";

import { leadSourceSchema, leadStatusSchema } from "./lead.schema";

/**
 * URL query parameter names and validation rules, verified against the backend's
 * `listLeadsQuerySchema` (`backend/src/modules/leads/http/lead-request.schema.ts`) — `q`
 * (min 2, max 120), `status`, `source`, `property_id` (UUID, parseable but not exposed as a
 * visual filter here, Prompt 044 section 21 preference B), `created_from`/`created_to`, `page`.
 * `sort`/`order` are deliberately not exposed in the URL by this first version (section 16/71)
 * — the backend's own default (`created_at desc`) is always used.
 */

const Q_MIN_LENGTH = 2;
const Q_MAX_LENGTH = 120;

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const uuidLikeSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

// A plain calendar date (`YYYY-MM-DD`) — the full ISO conversion for the API happens only in
// `listLeads` (see `lib/lead-date-range.ts`), never stored in the URL.
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Lenient, per-field schema (same convention as `propertyFiltersSchema`): an invalid value for
 * one field never invalidates the whole object — it's silently dropped (`.catch(undefined)`) so
 * a tampered/stale URL degrades to "filter not applied" instead of breaking the page.
 */
export const leadFiltersSchema = z.object({
  q: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(Q_MIN_LENGTH).max(Q_MAX_LENGTH).optional().catch(undefined),
  ),
  status: z.preprocess(emptyToUndefined, leadStatusSchema.optional().catch(undefined)),
  source: z.preprocess(emptyToUndefined, leadSourceSchema.optional().catch(undefined)),
  property_id: z.preprocess(emptyToUndefined, uuidLikeSchema.optional().catch(undefined)),
  created_from: z.preprocess(emptyToUndefined, dateOnlySchema.optional().catch(undefined)),
  created_to: z.preprocess(emptyToUndefined, dateOnlySchema.optional().catch(undefined)),
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).optional().catch(undefined)),
});
export type LeadFilters = z.infer<typeof leadFiltersSchema>;

// Deliberately excludes `page` — it narrows presentation, not the result set, so it doesn't
// count as an "active filter" for empty-state messaging purposes.
const FILTER_KEYS: (keyof LeadFilters)[] = [
  "q",
  "status",
  "source",
  "property_id",
  "created_from",
  "created_to",
];

/**
 * Parses filters straight out of `URLSearchParams` — an edited/stale/shared URL never breaks
 * the page (same convention as `parsePropertyFilters`).
 */
export function parseLeadFilters(searchParams: URLSearchParams): LeadFilters {
  const raw = Object.fromEntries(searchParams.entries());
  return leadFiltersSchema.parse(raw);
}

/**
 * Serializes filters back into `URLSearchParams`: empty/undefined params are omitted entirely,
 * and `page` is omitted whenever it's the default (1 or unset) to keep the URL clean.
 */
export function serializeLeadFilters(filters: LeadFilters): URLSearchParams {
  const params = new URLSearchParams();

  for (const key of FILTER_KEYS) {
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

export function hasActiveLeadFilters(filters: LeadFilters): boolean {
  return FILTER_KEYS.some((key) => filters[key] !== undefined);
}
