import { sql, type SQL } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * `tsvector` has no built-in Drizzle column type (this task, Prompt 025, section 39) — modeled
 * via `customType` purely so the TypeScript schema accurately reflects the real column
 * (`properties.searchVector` below). Selected only incidentally (`select()` never explicitly
 * picks it); `data: string` is never meant to be constructed by application code — the column
 * is always `GENERATED ALWAYS AS (...) STORED`, so nothing ever writes to it directly.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * Tenant Data Plane schema (ADR-001/ADR-003). Applied once per tenant database, never shared
 * — every table here belongs to exactly one tenant by virtue of living in that tenant's own
 * physical database. None of these tables carry a `tenant_id` column: the database itself is
 * the isolation boundary, so a tenant discriminator column would be redundant and would
 * reintroduce the exact shared-table risk ADR-001 rejected. Never imports Control Plane
 * tables — the two schemas are deliberately kept unaware of each other.
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Nullable: not every audited action has an authenticated actor (e.g. a system/background
  // job). No cascade delete — deleting a user must never delete their audit trail; the
  // reference is cleared instead so the log entry survives.
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "set null",
    onUpdate: "restrict",
  }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  // No foreign key: entityType varies per row, so there is no single target table to
  // reference.
  entityId: uuid("entity_id"),
  // No universal metadata shape defined yet — left schemaless on purpose.
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  // The business moment the event happened — distinct from createdAt (row insertion time),
  // and always supplied by the caller rather than defaulted, since backfilled/replayed
  // events legitimately have an occurredAt in the past.
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  // Set by the future outbox publisher (not implemented here) once the event is relayed.
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const propertyType = pgEnum("property_type", ["HOUSE", "APARTMENT", "LAND", "COMMERCIAL", "OTHER"]);

export const transactionType = pgEnum("transaction_type", ["SALE", "RENT"]);

// Deliberately small (Prompt 021): SOLD/RENTED would need a real state machine (who
// transitions it, from which prior status, is it reversible) that is not part of this task's
// scope. DRAFT/ACTIVE/INACTIVE covers "not yet published" / "published" / "withdrawn" without
// inventing that workflow ahead of a real requirement.
export const propertyStatus = pgEnum("property_status", ["DRAFT", "ACTIVE", "INACTIVE"]);

/**
 * First domain table of the Tenant Data Plane (Prompt 021). No `tenant_id` column, like every
 * other table in this schema — the physical database itself is the tenant isolation boundary
 * (ADR-001); a discriminator column here would reintroduce exactly the shared-table risk
 * ADR-001 rejected. No `created_by`/`owner_user_id` yet — there is no authenticated user
 * concept in this system yet (only the temporary `X-Tenant-Id` HTTP mechanism), and inventing
 * ownership fields ahead of real authentication would be guessing at a requirement that
 * doesn't exist.
 */
export const properties = pgTable(
  "properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description"),
    propertyType: propertyType("property_type").notNull(),
    transactionType: transactionType("transaction_type").notNull(),
    status: propertyStatus("status").notNull().default("DRAFT"),
    // NUMERIC, never float — money must never lose precision to binary floating point.
    // Drizzle's default numeric mode returns a string in JS, which also matches the HTTP
    // contract this task chose (price travels as a decimal string, never a JSON number).
    price: numeric("price", { precision: 15, scale: 2 }).notNull(),
    bedrooms: integer("bedrooms"),
    bathrooms: integer("bathrooms"),
    parkingSpaces: integer("parking_spaces"),
    // Same NUMERIC-not-float reasoning as price; nullable, since not every listing (e.g. LAND
    // without a finished construction) necessarily states a build area at creation time.
    areaM2: numeric("area_m2", { precision: 10, scale: 2 }),
    street: text("street"),
    number: text("number"),
    complement: text("complement"),
    neighborhood: text("neighborhood"),
    city: text("city"),
    // Brazilian UF: two letters, never a separate lookup table for a fixed, tiny set of
    // values (this task, section 15).
    state: varchar("state", { length: 2 }),
    postalCode: text("postal_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Full-text search vector (Prompt 025) — `GENERATED ALWAYS AS (...) STORED`, so PostgreSQL
     * recomputes it automatically on every INSERT/UPDATE (never written to by application
     * code, never present in `CreatePropertyInput`/`UpdatePropertyInput`). `'portuguese'`
     * config confirmed present on this project's PostgreSQL image (`pg_ts_config`) before
     * writing this. Built from `title`/`neighborhood`/`city`/`street`/`description` only —
     * `price`/`postal_code`/`state`/`property_type`/`transaction_type`/`status` already have
     * structured filters and are poor FTS candidates (section 5). `coalesce(..., '')` so a
     * `NULL` field contributes nothing rather than nulling the whole vector. `setweight()`
     * ranks a match in `title` (A) above `neighborhood`/`city` (B), above `street` (C), above
     * `description` (D) — deliberately simple, no further relevance tuning (section 10). The
     * callback form (`(): SQL => ...`) is required, not stylistic: it closes over the `properties`
     * table binding below, which does not exist yet while this config object is being built —
     * Drizzle defers evaluation until introspection/migration-generation time, by which point
     * `properties` is fully assigned (the documented pattern for a generated column that
     * references sibling columns of the same table).
     */
    searchVector: tsvector("search_vector")
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`
          setweight(to_tsvector('portuguese', coalesce(${properties.title}, '')), 'A') ||
          setweight(to_tsvector('portuguese', coalesce(${properties.neighborhood}, '')), 'B') ||
          setweight(to_tsvector('portuguese', coalesce(${properties.city}, '')), 'B') ||
          setweight(to_tsvector('portuguese', coalesce(${properties.street}, '')), 'C') ||
          setweight(to_tsvector('portuguese', coalesce(${properties.description}, '')), 'D')
        `,
      ),
  },
  (t) => [
    // Serves the only query this task's listing needs — ORDER BY created_at DESC, id DESC —
    // directly from the index. No index yet on status/property_type/transaction_type/city:
    // this task's GET /properties has no filter parameters, so an index on a column nothing
    // queries would be speculative (CLAUDE.md: avoid abstractions without a concrete
    // consumer) — add one if/when a filtered listing is actually built.
    index("properties_created_at_id_idx").on(t.createdAt.desc(), t.id.desc()),
    // GIN over the generated tsvector — this is the one case in this schema (Prompt 025,
    // section 11) where an index is added ahead of a real usage pattern, because the column it
    // covers exists for exactly one purpose (search_vector @@ websearch_to_tsquery(...)) and is
    // useless without it.
    index("properties_search_vector_idx").using("gin", t.searchVector),
    check("properties_price_positive", sql`${t.price} > 0`),
    check("properties_bedrooms_non_negative", sql`${t.bedrooms} IS NULL OR ${t.bedrooms} >= 0`),
    check("properties_bathrooms_non_negative", sql`${t.bathrooms} IS NULL OR ${t.bathrooms} >= 0`),
    check(
      "properties_parking_spaces_non_negative",
      sql`${t.parkingSpaces} IS NULL OR ${t.parkingSpaces} >= 0`,
    ),
    check("properties_area_m2_positive", sql`${t.areaM2} IS NULL OR ${t.areaM2} > 0`),
  ],
);
