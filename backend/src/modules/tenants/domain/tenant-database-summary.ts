/**
 * Mirrors `tenant_database_status`/`database_cluster_status` in
 * `infrastructure/database/control-plane/schema.ts` manually — the same domain/schema
 * duplication already used for `TenantStatus` in `tenant.ts`. The application layer never
 * imports a Drizzle enum type directly.
 */
export type TenantDatabaseStatus = "PROVISIONING" | "READY" | "FAILED";
export type DatabaseClusterStatus = "ACTIVE" | "INACTIVE";

/**
 * Summary of a tenant's database cluster, as surfaced by the tenant listing (Prompt 033).
 * Deliberately excludes `host`/`port`/`secretReference` — connection/credential detail, never
 * part of this read-only administrative summary.
 */
export interface TenantDatabaseClusterSummary {
  id: string;
  name: string;
  provider: string;
  region: string;
  status: DatabaseClusterStatus;
}

/**
 * Summary of a tenant's registered database, as surfaced by the tenant listing (Prompt 033).
 * Deliberately excludes `secretReference` — never part of this read-only administrative
 * summary. `cluster` is `null` only in the defensive case where `tenant_databases` points at a
 * cluster that could not be resolved by the LEFT JOIN — never thrown as a 500 (this task,
 * section 16).
 */
export interface TenantDatabaseSummary {
  status: TenantDatabaseStatus;
  databaseName: string;
  schemaVersion: number;
  cluster: TenantDatabaseClusterSummary | null;
}
