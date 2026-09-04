import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";

import type { ControlPlaneDatabase } from "../../../infrastructure/database/control-plane/client.js";
import {
  databaseClusters,
  provisioningJobs,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import { isUniqueViolation } from "../../../infrastructure/database/postgres-errors.js";
import type { TenantDatabaseClusterSummary } from "../domain/tenant-database-summary.js";
import type { ProvisioningJobSummary } from "../domain/tenant-provisioning-job-summary.js";
import type { TenantDetails, TenantListItem } from "../domain/tenant.js";
import { TenantSlugAlreadyExistsError, type Tenant } from "../domain/tenant.js";
import type {
  CreateTenantInput,
  ListTenantsInput,
  ListTenantsResult,
  TenantListFilters,
  TenantRepository,
} from "../application/tenant-repository.js";

const SLUG_UNIQUE_CONSTRAINT = "tenants_slug_unique";

/**
 * `TenantListFilters` → Drizzle `WHERE` conditions, shared by both the data query and the count
 * query in `list()` below (this task, section 22) — one place that knows how a filter maps to
 * SQL, so the two can never drift apart. Only ever references `tenants` columns: neither filter
 * touches `tenant_databases`/`database_clusters`, so the count query below never needs the
 * joins the data query uses (this task, section 32 — no extra query, no N+1).
 */
function buildTenantListConditions(filters: TenantListFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.status !== undefined) conditions.push(eq(tenants.status, filters.status));
  // Substring, case-insensitive (this task, section 7) — deliberately `ILIKE '%...%'`, unlike
  // Properties' exact-match `city`/full-text `q`: this task explicitly asks for a simple
  // substring search over name/slug/email, not full-text search (section 7: "não implementar
  // full-text search para tenants").
  if (filters.query !== undefined) {
    const pattern = `%${filters.query}%`;
    const match = or(ilike(tenants.name, pattern), ilike(tenants.slug, pattern));
    if (match) conditions.push(match);
  }

  return conditions;
}

type TenantRow = typeof tenants.$inferSelect;
type TenantDatabaseRow = typeof tenantDatabases.$inferSelect;
type DatabaseClusterRow = typeof databaseClusters.$inferSelect;
type ProvisioningJobRow = typeof provisioningJobs.$inferSelect;

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Identical shape needed by both `TenantListItem.database.cluster` (Prompt 033) and
 * `TenantDetails.database.cluster` (Prompt 034, this task, section 26) — the one genuinely
 * shared mapping between the two, factored out to avoid drift.
 */
function toClusterSummary(row: DatabaseClusterRow): TenantDatabaseClusterSummary {
  return { id: row.id, name: row.name, provider: row.provider, region: row.region, status: row.status };
}

/**
 * Joined row → `TenantListItem`. `database`/`cluster` are `null` exactly when the LEFT JOIN
 * found no matching row (this task, sections 15/16) — never an artificial/synthesized object,
 * and never a thrown error just because a tenant has no database yet.
 */
function toTenantListItem(row: {
  tenant: TenantRow;
  database: TenantDatabaseRow | null;
  cluster: DatabaseClusterRow | null;
}): TenantListItem {
  return {
    ...toTenant(row.tenant),
    database: row.database
      ? {
          status: row.database.status,
          databaseName: row.database.databaseName,
          schemaVersion: row.database.schemaVersion,
          cluster: row.cluster ? toClusterSummary(row.cluster) : null,
        }
      : null,
  };
}

function toProvisioningJobSummary(row: ProvisioningJobRow): ProvisioningJobSummary {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dispatchedAt: row.dispatchedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorMessage: row.errorMessage,
  };
}

/**
 * Real, Drizzle-backed `TenantRepository`. `list()` queries the Control Plane exclusively —
 * `tenants` LEFT JOIN `tenant_databases` LEFT JOIN `database_clusters` — never a tenant's own
 * database (this task, section 31). The LEFT JOINs never multiply a tenant across rows:
 * `tenant_databases.tenant_id` carries a `UNIQUE` constraint (schema.ts), so at most one
 * `tenant_databases` row — and therefore at most one `database_clusters` row, via its `NOT
 * NULL` FK — can match per tenant (this task, section 23). `findDetailsById` (Prompt 034)
 * reuses the same joins for one tenant, plus a second, independent query for the latest
 * `provisioning_jobs` row — two fixed queries, never proportional to job history (section 18).
 */
export function createDrizzleTenantRepository(db: ControlPlaneDatabase): TenantRepository {
  return {
    async createWithProvisioningIntent(input: CreateTenantInput): Promise<Tenant> {
      try {
        return await db.transaction(async (tx) => {
          // id, status and timestamps come from the database defaults.
          const [tenant] = await tx
            .insert(tenants)
            .values({ name: input.name, slug: input.slug })
            .returning();

          if (!tenant) {
            throw new Error("Tenant insert returned no row");
          }

          // status, attempts and the remaining nullable columns come from the database
          // defaults — recording the row is the entire "provisioning intent" at this stage.
          await tx.insert(provisioningJobs).values({
            tenantId: tenant.id,
            type: "CREATE_DATABASE",
          });

          return tenant;
        });
      } catch (error) {
        // The UNIQUE constraint is the authoritative guard against concurrent inserts.
        if (isUniqueViolation(error, SLUG_UNIQUE_CONSTRAINT)) {
          throw new TenantSlugAlreadyExistsError(input.slug);
        }

        throw error;
      }
    },

    async list(input: ListTenantsInput): Promise<ListTenantsResult> {
      const offset = (input.page - 1) * input.limit;
      const conditions = buildTenantListConditions(input.filters);
      // Same `conditions` array feeds both queries below — the total this reports is always the
      // filtered total (this task, section 22).
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select({ tenant: tenants, database: tenantDatabases, cluster: databaseClusters })
          .from(tenants)
          .leftJoin(tenantDatabases, eq(tenantDatabases.tenantId, tenants.id))
          .leftJoin(databaseClusters, eq(databaseClusters.id, tenantDatabases.clusterId))
          .where(whereClause)
          // Deterministic (this task, section 10): created_at DESC, id DESC as a tie-breaker —
          // never unstable pagination even when many tenants share the same created_at.
          .orderBy(desc(tenants.createdAt), desc(tenants.id))
          .limit(input.limit)
          .offset(offset),
        db.select({ count: sql<string>`count(*)` }).from(tenants).where(whereClause),
      ]);

      return { data: rows.map(toTenantListItem), total: Number(totalRows[0]?.count ?? 0) };
    },

    async findDetailsById(id: string): Promise<TenantDetails | null> {
      const [row] = await db
        .select({ tenant: tenants, database: tenantDatabases, cluster: databaseClusters })
        .from(tenants)
        .leftJoin(tenantDatabases, eq(tenantDatabases.tenantId, tenants.id))
        .leftJoin(databaseClusters, eq(databaseClusters.id, tenantDatabases.clusterId))
        .where(eq(tenants.id, id));

      if (!row) return null;

      // Independent query, deliberately not a third JOIN (this task, section 18): a tenant may
      // have many historical provisioning jobs, and joining them in would either multiply the
      // single tenant row across every job or require a much less obvious lateral-join query
      // for no real benefit — `ORDER BY ... LIMIT 1` here is already O(1), never proportional
      // to job history (section 12: created_at DESC, id DESC, deterministic).
      const [jobRow] = await db
        .select()
        .from(provisioningJobs)
        .where(eq(provisioningJobs.tenantId, id))
        .orderBy(desc(provisioningJobs.createdAt), desc(provisioningJobs.id))
        .limit(1);

      return {
        ...toTenant(row.tenant),
        database: row.database
          ? {
              status: row.database.status,
              databaseName: row.database.databaseName,
              schemaVersion: row.database.schemaVersion,
              createdAt: row.database.createdAt,
              updatedAt: row.database.updatedAt,
              cluster: row.cluster ? toClusterSummary(row.cluster) : null,
            }
          : null,
        latestProvisioningJob: jobRow ? toProvisioningJobSummary(jobRow) : null,
      };
    },
  };
}
