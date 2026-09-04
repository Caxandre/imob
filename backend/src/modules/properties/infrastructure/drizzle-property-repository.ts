import { and, asc, desc, eq, gte, ilike, inArray, lte, type SQL, sql } from "drizzle-orm";

import { propertyMedia, propertyMediaVariants, properties } from "../../../infrastructure/database/tenant/schema.js";
import type { TenantDatabase } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { PropertyCover, PropertyCoverVariantSet, PropertyWithCover } from "../domain/property-cover.js";
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
import { toPropertyMediaVariant } from "./drizzle-property-media-repository.js";

/**
 * `filters.query` → a parameterized `websearch_to_tsquery('portuguese', ...)` expression, built
 * once and shared between the `WHERE` condition (`buildPropertyListConditions`) and the
 * relevance `ORDER BY` (`buildPropertyOrderBy`) — both must rank/filter against the exact same
 * parsed query, never two independently-built ones that could drift (this task, section 18/24).
 * The `q` text is always passed as a Drizzle `sql` template parameter, never concatenated into
 * the query string (section 16) — `websearch_to_tsquery` itself is what turns natural input
 * (`"vista mar"`, `apartamento -reforma`) into a safe, structured tsquery; PostgreSQL rejects
 * malformed input by raising an error (mapped to a controlled response like any other unexpected
 * error, never a leaked raw SQL/query string — section 52), not by ever executing raw SQL.
 */
function buildSearchQuery(query: string): SQL {
  return sql`websearch_to_tsquery('portuguese', ${query})`;
}

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
  // Full-text search (this task) — matched against the generated `search_vector` column
  // (`infrastructure/database/tenant/schema.ts`), never `ILIKE '%...%'`.
  if (filters.query !== undefined) {
    conditions.push(sql`${properties.searchVector} @@ ${buildSearchQuery(filters.query)}`);
  }

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
 * DESC as a tie-breaker, so pagination is never unstable even when many rows share the same
 * value on the primary column. Nullable columns always sort `NULLS LAST`, in both directions
 * (section 27), via an explicit `sql` fragment — Drizzle's `asc`/`desc` helpers have no built-in
 * NULLS LAST/FIRST modifier.
 *
 * `sort === "relevance"` (Prompt 025) is the one case `order` never applies to — it is always
 * `ts_rank(...) DESC, id DESC` (this task, section 19: one deterministic ordering, not a
 * user-configurable direction on top of relevance). The HTTP layer only ever produces this value
 * when `filters.query` is set (see `PropertySort` in `property-repository.ts`); the check below
 * is a defensive guard against that invariant being violated, not a real runtime path.
 */
function buildPropertyOrderBy(sort: PropertySort, order: SortOrder, filters: PropertyListFilters): SQL[] {
  const idDesc = desc(properties.id);

  if (sort === "relevance") {
    if (filters.query === undefined) {
      throw new Error('buildPropertyOrderBy: sort "relevance" requires filters.query to be set');
    }
    const rank = sql`ts_rank(${properties.searchVector}, ${buildSearchQuery(filters.query)})`;
    return [desc(rank), idDesc];
  }

  const idOrder = order === "asc" ? asc(properties.id) : idDesc;

  if (NULLABLE_SORT_FIELDS.has(sort)) {
    const column = sort === "area_m2" ? properties.areaM2 : properties.bedrooms;
    const primary = order === "asc" ? sql`${column} ASC NULLS LAST` : sql`${column} DESC NULLS LAST`;
    return [primary, idOrder];
  }

  const column =
    sort === "created_at" ? properties.createdAt : sort === "updated_at" ? properties.updatedAt : properties.price;
  return [order === "asc" ? asc(column) : desc(column), idOrder];
}

/**
 * Loads one summarized cover media per property id, with a fixed number of queries regardless
 * of how many properties are on the page — never one query per property (Prompt 037A, sections
 * 15/16/62). `propertyIds.length === 0` short-circuits before any query at all (section 33/63:
 * an empty page of results skips cover lookup entirely).
 *
 * Query 1 (this function's own): exactly one candidate `property_media` row per property —
 * `is_cover DESC, position ASC, id ASC` selects the explicit cover when one exists, and falls
 * back deterministically to the first-by-position media otherwise (sections 7/8/18/19) — never
 * assumes `is_cover` is always set correctly. Expressed as a `ROW_NUMBER() OVER (PARTITION BY
 * property_id ...)` subquery, filtered to `rank = 1` outside it (window functions cannot be
 * referenced in the same query's own `WHERE`).
 *
 * Query 2: `THUMBNAIL`/`CARD` variants only (section 5/20 — never `DETAIL`), for exactly the
 * cover media ids just selected — never a query per media, and skipped entirely when no
 * property in this batch has any media at all (section 33).
 */
async function loadCoversByPropertyIds(
  db: TenantDatabase,
  propertyIds: readonly string[],
): Promise<Map<string, PropertyCover>> {
  const covers = new Map<string, PropertyCover>();
  if (propertyIds.length === 0) return covers;

  const rankedMedia = db
    .select({
      propertyId: propertyMedia.propertyId,
      mediaId: propertyMedia.id,
      publicUrl: propertyMedia.publicUrl,
      processingStatus: propertyMedia.processingStatus,
      rank: sql<number>`row_number() over (
        partition by ${propertyMedia.propertyId}
        order by ${propertyMedia.isCover} desc, ${propertyMedia.position} asc, ${propertyMedia.id} asc
      )`.as("rank"),
    })
    .from(propertyMedia)
    .where(inArray(propertyMedia.propertyId, propertyIds as string[]))
    .as("ranked_cover_media");

  const coverRows = await db.select().from(rankedMedia).where(eq(rankedMedia.rank, 1));
  if (coverRows.length === 0) return covers;

  const coverMediaIds = coverRows.map((row) => row.mediaId);
  const variantRows = await db
    .select()
    .from(propertyMediaVariants)
    .where(
      and(
        inArray(propertyMediaVariants.propertyMediaId, coverMediaIds),
        inArray(propertyMediaVariants.variant, ["THUMBNAIL", "CARD"]),
      ),
    );

  // Grouped by property_media_id in memory (section 21) — never dependent on row order.
  const variantsByMediaId = new Map<string, PropertyCoverVariantSet>();
  for (const row of variantRows) {
    const variant = toPropertyMediaVariant(row);
    const bucket = variantsByMediaId.get(variant.propertyMediaId) ?? { thumbnail: null, card: null };
    if (variant.variant === "THUMBNAIL") bucket.thumbnail = variant;
    else if (variant.variant === "CARD") bucket.card = variant;
    variantsByMediaId.set(variant.propertyMediaId, bucket);
  }

  for (const row of coverRows) {
    covers.set(row.propertyId, {
      id: row.mediaId,
      publicUrl: row.publicUrl,
      processingStatus: row.processingStatus,
      variants: variantsByMediaId.get(row.mediaId) ?? { thumbnail: null, card: null },
    });
  }

  return covers;
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
      const orderBy = buildPropertyOrderBy(input.sort, input.order, input.filters);

      const [data, totalRows] = await Promise.all([
        db.select().from(properties).where(whereClause).orderBy(...orderBy).limit(input.limit).offset(offset),
        db.select({ count: sql<string>`count(*)` }).from(properties).where(whereClause),
      ]);

      // Cover enrichment never touches the count query above, and never changes `data`'s
      // ordering — it only attaches a `cover` to rows already selected/ordered/paginated by
      // the two queries above (this task, sections 26/27/28).
      const covers = await loadCoversByPropertyIds(db, data.map((row) => row.id));
      const withCover: PropertyWithCover[] = data.map((row) => ({
        ...toProperty(row),
        cover: covers.get(row.id) ?? null,
      }));

      return { data: withCover, total: Number(totalRows[0]?.count ?? 0) };
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
