import { and, asc, desc, eq, gte, ilike, lte, type SQL, sql } from "drizzle-orm";

import { properties } from "../../../infrastructure/database/tenant/schema.js";
import type { TenantDatabase } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { Property } from "../domain/property.js";
import type {
  CreatePropertyInput,
  ListPropertiesInput,
  ListPropertiesResult,
  PropertyListFilters,
  PropertyRepository,
  PropertySort,
  SortOrder,
  UpdatePropertyInput,
} from "../application/property-repository.js";

/**
 * `PropertyListFilters` → Drizzle `WHERE` conditions, one function shared by both the data query
 * and the count query in `list()` below (this task, section 35) — there is exactly one place
 * that knows how a filter maps to SQL, so the two queries can never drift apart. Every condition
 * is built with Drizzle's typed operators (`eq`/`gte`/`lte`/`ilike`) over a known column; no
 * user-controlled string is ever concatenated into SQL (this task, section 34). A filter absent
 * from `filters` contributes no condition at all — never a condition that happens to match
 * everything — which is what gives nullable numeric columns their natural SQL behavior (this
 * task, section 17): `bedrooms >= 2` is `NULL` (not true) for a row with `bedrooms IS NULL`, so
 * it is correctly excluded without any special-casing here.
 */
function buildPropertyListConditions(filters: PropertyListFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.status !== undefined) conditions.push(eq(properties.status, filters.status));
  if (filters.propertyType !== undefined) conditions.push(eq(properties.propertyType, filters.propertyType));
  if (filters.transactionType !== undefined) {
    conditions.push(eq(properties.transactionType, filters.transactionType));
  }
  // `ilike` with no wildcard characters in the value is a case-insensitive exact match — never
  // a substring/full-text search (this task, section 9).
  if (filters.city !== undefined) conditions.push(ilike(properties.city, filters.city));
  if (filters.state !== undefined) conditions.push(eq(properties.state, filters.state));
  if (filters.priceMin !== undefined) conditions.push(gte(properties.price, filters.priceMin));
  if (filters.priceMax !== undefined) conditions.push(lte(properties.price, filters.priceMax));
  if (filters.bedroomsMin !== undefined) conditions.push(gte(properties.bedrooms, filters.bedroomsMin));
  if (filters.bathroomsMin !== undefined) conditions.push(gte(properties.bathrooms, filters.bathroomsMin));
  if (filters.parkingSpacesMin !== undefined) {
    conditions.push(gte(properties.parkingSpaces, filters.parkingSpacesMin));
  }
  if (filters.areaMin !== undefined) conditions.push(gte(properties.areaM2, filters.areaMin));
  if (filters.areaMax !== undefined) conditions.push(lte(properties.areaM2, filters.areaMax));

  return conditions;
}

// Columns whose sort can legitimately hit NULL (`area_m2`/`bedrooms` are nullable) — every other
// sortable column is NOT NULL, so plain `asc`/`desc` already produces a total order with no NULL
// placement decision to make. This distinguishes when the explicit `NULLS LAST` SQL below is
// actually needed (this task, section 27).
const NULLABLE_SORT_FIELDS: ReadonlySet<PropertySort> = new Set(["area_m2", "bedrooms"]);

/**
 * `sort`/`order` → Drizzle `ORDER BY` clauses, always through this fixed mapping — the raw query
 * values are never interpolated into SQL (this task, section 26). Every ordering ends with `id`
 * in the same direction as the primary sort as a tie-breaker (section 25), so pagination is
 * never unstable even when many rows share the same value on the primary column. Nullable
 * columns always sort `NULLS LAST`, in both directions (section 27), via an explicit `sql`
 * fragment — Drizzle's `asc`/`desc` helpers have no built-in NULLS LAST/FIRST modifier.
 */
function buildPropertyOrderBy(sort: PropertySort, order: SortOrder): SQL[] {
  const idOrder = order === "asc" ? asc(properties.id) : desc(properties.id);

  if (NULLABLE_SORT_FIELDS.has(sort)) {
    const column = sort === "area_m2" ? properties.areaM2 : properties.bedrooms;
    const primary = order === "asc" ? sql`${column} ASC NULLS LAST` : sql`${column} DESC NULLS LAST`;
    return [primary, idOrder];
  }

  const column =
    sort === "created_at" ? properties.createdAt : sort === "updated_at" ? properties.updatedAt : properties.price;
  return [order === "asc" ? asc(column) : desc(column), idOrder];
}

function toProperty(row: typeof properties.$inferSelect): Property {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    propertyType: row.propertyType,
    transactionType: row.transactionType,
    status: row.status,
    price: row.price,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    parkingSpaces: row.parkingSpaces,
    areaM2: row.areaM2,
    street: row.street,
    number: row.number,
    complement: row.complement,
    neighborhood: row.neighborhood,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Real, Drizzle-backed `PropertyRepository`. Takes an already-scoped `TenantDatabase` — the
 * exact instance `TenantDatabaseConnectionManager.withTenantDatabase()` hands out for one
 * resolved tenant — never a `tenantId` or a way to pick which database to talk to; there is no
 * `tenant_id` column to filter by, because the database connection itself is already scoped
 * to one tenant (ADR-001).
 */
export function createDrizzlePropertyRepository(db: TenantDatabase): PropertyRepository {
  return {
    async create(input: CreatePropertyInput): Promise<Property> {
      const [row] = await db.insert(properties).values(input).returning();
      if (!row) {
        throw new Error("property insert returned no row");
      }
      return toProperty(row);
    },

    async list(input: ListPropertiesInput): Promise<ListPropertiesResult> {
      const offset = (input.page - 1) * input.limit;
      const conditions = buildPropertyListConditions(input.filters);
      // Same `conditions` array feeds both queries below — the total this reports is always
      // the filtered total, never the tenant's overall count (this task, sections 20/35).
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      const orderBy = buildPropertyOrderBy(input.sort, input.order);

      const [data, totalRows] = await Promise.all([
        db.select().from(properties).where(whereClause).orderBy(...orderBy).limit(input.limit).offset(offset),
        db.select({ count: sql<string>`count(*)` }).from(properties).where(whereClause),
      ]);

      return { data: data.map(toProperty), total: Number(totalRows[0]?.count ?? 0) };
    },

    async findById(id: string): Promise<Property | undefined> {
      const [row] = await db.select().from(properties).where(eq(properties.id, id));
      return row ? toProperty(row) : undefined;
    },

    async update(id: string, input: UpdatePropertyInput): Promise<Property | undefined> {
      // Only ever called with at least one field — the HTTP boundary's Zod schema already
      // rejects an empty PATCH body before this repository is reached.
      const [row] = await db
        .update(properties)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(properties.id, id))
        .returning();
      return row ? toProperty(row) : undefined;
    },

    async archive(id: string): Promise<Property | undefined> {
      // Always runs the same UPDATE regardless of current status — idempotent by convergence
      // (the same pattern already used for provisioning idempotency in this codebase), not by
      // a read-before-write short circuit.
      const [row] = await db
        .update(properties)
        .set({ status: "INACTIVE", updatedAt: sql`now()` })
        .where(eq(properties.id, id))
        .returning();
      return row ? toProperty(row) : undefined;
    },
  };
}
