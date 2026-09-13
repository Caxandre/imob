import { and, asc, desc, eq, gte, ilike, lte, or, type SQL, sql } from "drizzle-orm";

import { isCheckViolation } from "../../../infrastructure/database/postgres-errors.js";
import { leads, properties } from "../../../infrastructure/database/tenant/schema.js";
import type { TenantDatabase } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import { LeadContactChannelRequiredError, type Lead } from "../domain/lead.js";
import type { LeadWithPropertySummary } from "../domain/lead-property-summary.js";
import type {
  CreateLeadInput,
  LeadListFilters,
  LeadRepository,
  LeadSort,
  ListLeadsInput,
  ListLeadsResult,
  SortOrder,
  UpdateLeadInput,
} from "../application/lead-repository.js";

/** Named in `infrastructure/database/tenant/schema.ts` — the last-resort barrier for the
 * "at least one contact channel" invariant (Prompt 043, section 49). */
const CONTACT_CHANNEL_CHECK_CONSTRAINT = "leads_contact_channel_required";

/**
 * `LeadListFilters` → Drizzle `WHERE` conditions, one function shared by both the data query and
 * the count query in `list()` below — same convention as `buildPropertyListConditions`, so the
 * two queries can never drift apart. `query` (the `q` param) is matched via `ILIKE` against
 * `name`/`email`/`phone` (Prompt 043, section 21) — deliberately not full-text search; leads
 * have too little text and too little volume yet to justify it.
 */
function buildLeadListConditions(filters: LeadListFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.status !== undefined) conditions.push(eq(leads.status, filters.status));
  if (filters.source !== undefined) conditions.push(eq(leads.source, filters.source));
  if (filters.propertyId !== undefined) conditions.push(eq(leads.propertyId, filters.propertyId));
  if (filters.createdFrom !== undefined) conditions.push(gte(leads.createdAt, filters.createdFrom));
  if (filters.createdTo !== undefined) conditions.push(lte(leads.createdAt, filters.createdTo));
  if (filters.query !== undefined) {
    const pattern = `%${filters.query}%`;
    const searchCondition = or(ilike(leads.name, pattern), ilike(leads.email, pattern), ilike(leads.phone, pattern));
    if (searchCondition) conditions.push(searchCondition);
  }

  return conditions;
}

/**
 * `sort`/`order` → Drizzle `ORDER BY` clauses, always through this fixed mapping — the raw
 * query values are never interpolated into SQL (Prompt 043, section 39). Every ordering ends
 * with `id` as a tie-breaker (same direction as the primary column), so pagination is never
 * unstable. Unlike `properties`, none of the sortable `leads` columns are nullable, so no
 * `NULLS LAST` handling is needed here.
 */
function buildLeadOrderBy(sort: LeadSort, order: SortOrder): SQL[] {
  const column =
    sort === "created_at"
      ? leads.createdAt
      : sort === "updated_at"
        ? leads.updatedAt
        : sort === "name"
          ? leads.name
          : leads.status;
  const idOrder = order === "asc" ? asc(leads.id) : desc(leads.id);

  return [order === "asc" ? asc(column) : desc(column), idOrder];
}

function toLead(row: typeof leads.$inferSelect): Lead {
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    source: row.source,
    message: row.message,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Real, Drizzle-backed `LeadRepository`. Takes an already-scoped `TenantDatabase` — never a
 * `tenantId` or a way to pick which database to talk to — same convention as
 * `createDrizzlePropertyRepository`.
 */
export function createDrizzleLeadRepository(db: TenantDatabase): LeadRepository {
  return {
    async create(input: CreateLeadInput): Promise<Lead> {
      try {
        const [row] = await db.insert(leads).values(input).returning();
        if (!row) {
          throw new Error("lead insert returned no row");
        }
        return toLead(row);
      } catch (error) {
        // Defense in depth only (Prompt 043, section 49) — the HTTP boundary's Zod schema
        // already rejects a create payload with neither email nor phone before this repository
        // is ever reached, so this branch is not expected to be reachable in normal operation.
        if (isCheckViolation(error, CONTACT_CHANNEL_CHECK_CONSTRAINT)) {
          throw new LeadContactChannelRequiredError();
        }
        throw error;
      }
    },

    async list(input: ListLeadsInput): Promise<ListLeadsResult> {
      const offset = (input.page - 1) * input.limit;
      const conditions = buildLeadListConditions(input.filters);
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      const orderBy = buildLeadOrderBy(input.sort, input.order);

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            lead: leads,
            property: { id: properties.id, title: properties.title, status: properties.status },
          })
          .from(leads)
          .leftJoin(properties, eq(leads.propertyId, properties.id))
          .where(whereClause)
          .orderBy(...orderBy)
          .limit(input.limit)
          .offset(offset),
        db.select({ count: sql<string>`count(*)` }).from(leads).where(whereClause),
      ]);

      const data: LeadWithPropertySummary[] = rows.map((row) => ({
        ...toLead(row.lead),
        property: row.property,
      }));

      return { data, total: Number(totalRows[0]?.count ?? 0) };
    },

    async findById(id: string): Promise<LeadWithPropertySummary | undefined> {
      const [row] = await db
        .select({
          lead: leads,
          property: { id: properties.id, title: properties.title, status: properties.status },
        })
        .from(leads)
        .leftJoin(properties, eq(leads.propertyId, properties.id))
        .where(eq(leads.id, id));

      if (!row) {
        return undefined;
      }

      return { ...toLead(row.lead), property: row.property };
    },

    async update(id: string, input: UpdateLeadInput): Promise<Lead | undefined> {
      // Only ever called with at least one field — the HTTP boundary's Zod schema already
      // rejects an empty PATCH body before this repository is reached.
      try {
        const [row] = await db
          .update(leads)
          .set({ ...input, updatedAt: sql`now()` })
          .where(eq(leads.id, id))
          .returning();
        return row ? toLead(row) : undefined;
      } catch (error) {
        // Last-resort barrier against a race between two concurrent updates each clearing a
        // different contact channel (Prompt 043, section 49) — `update-lead.ts`'s own
        // resulting-state pre-check closes this in the common case, but only a real transaction
        // can see a truly concurrent write.
        if (isCheckViolation(error, CONTACT_CHANNEL_CHECK_CONSTRAINT)) {
          throw new LeadContactChannelRequiredError(id);
        }
        throw error;
      }
    },
  };
}
