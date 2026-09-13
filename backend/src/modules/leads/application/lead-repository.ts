import type { Lead, LeadSource, LeadStatus } from "../domain/lead.js";
import type { LeadWithPropertySummary } from "../domain/lead-property-summary.js";

/**
 * `status` is deliberately absent here (Prompt 043, section 15) — a new lead is always `NEW`,
 * enforced by the column default (`infrastructure/database/tenant/schema.ts`) rather than a
 * value this input could ever override. The HTTP boundary's Zod schema
 * (`lead-request.schema.ts`) never accepts `status` in the create body either — a client cannot
 * invent an initial lifecycle state through any layer.
 */
export interface CreateLeadInput {
  propertyId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  source: LeadSource;
  message: string | null;
  notes: string | null;
}

/**
 * Structured filters for `GET /api/v1/leads` (Prompt 043, section 33) — every field optional,
 * AND-combined, same convention as `PropertyListFilters`. `query` (the `q` param) is already
 * trimmed/length-validated at the HTTP boundary; matched via `ILIKE` against `name`/`email`/
 * `phone` in the repository (section 21) — never PostgreSQL full-text search (leads have too
 * little text and too little volume yet to justify it, unlike `properties.search_vector`).
 */
export interface LeadListFilters {
  status?: LeadStatus;
  source?: LeadSource;
  propertyId?: string;
  /** Inclusive lower bound on `created_at`. */
  createdFrom?: Date;
  /** Inclusive upper bound on `created_at`. */
  createdTo?: Date;
  query?: string;
}

/** Closed allowlist (Prompt 043, section 39) — `sort`/`order` are never interpolated into SQL
 * directly, always mapped through this type to a known Drizzle column. */
export type LeadSort = "created_at" | "updated_at" | "name" | "status";

export type SortOrder = "asc" | "desc";

export interface ListLeadsInput {
  page: number;
  limit: number;
  filters: LeadListFilters;
  sort: LeadSort;
  order: SortOrder;
}

export interface ListLeadsResult {
  data: LeadWithPropertySummary[];
  total: number;
}

/**
 * Partial update — PATCH semantics (Prompt 043, sections 47/48), same "absent means unchanged,
 * present-with-`null` means clear it" convention as `UpdatePropertyInput`. `status` may be set
 * to any `LeadStatus` value from any current value (section 50 — no state machine yet).
 */
export interface UpdateLeadInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  propertyId?: string | null;
  status?: LeadStatus;
  source?: LeadSource;
  message?: string | null;
  notes?: string | null;
}

/**
 * Persistence port for the Leads module. Always operates against a single tenant's own
 * database — an already-scoped `db` handle, never a `tenantId` parameter — same convention as
 * `PropertyRepository`.
 */
export interface LeadRepository {
  create(input: CreateLeadInput): Promise<Lead>;
  /** Each item includes a summarized property association (Prompt 043, section 42) — loaded
   * via a single `LEFT JOIN`, never one query per lead. */
  list(input: ListLeadsInput): Promise<ListLeadsResult>;
  /** Returns `undefined` when no lead with that id exists — never throws for "not found". */
  findById(id: string): Promise<LeadWithPropertySummary | undefined>;
  /**
   * Returns `undefined` when no lead with that id exists. Throws
   * {@link import("../domain/lead.js").LeadContactChannelRequiredError} if the database CHECK
   * itself rejects the resulting row (section 49) — a last-resort guard against a race the
   * application layer's own pre-check (`update-lead.ts`) cannot fully close.
   */
  update(id: string, input: UpdateLeadInput): Promise<Lead | undefined>;
}
