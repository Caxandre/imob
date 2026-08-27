import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as tenantSchema from "../../../infrastructure/database/tenant/schema.js";
import type { TenantDatabaseTarget } from "./tenant-database-resolver.js";

/**
 * A Drizzle instance typed exclusively with the Tenant Data Plane schema (`users`,
 * `audit_logs`, `outbox_events`) — Control Plane tables (`tenants`, `tenant_databases`, ...)
 * never appear on this type, so Tenant Data Plane repository code cannot accidentally query
 * them through the connection this module hands out.
 */
export type TenantDatabase = NodePgDatabase<typeof tenantSchema>;

/**
 * Opens (and reuses) real PostgreSQL connections to a tenant's physical database, always
 * authenticated with the tenant application credential resolved from
 * `TenantDatabaseTarget.secretReference` — never the cluster admin credential (CLAUDE.md).
 * Deliberately separate from `TenantDatabaseResolver`: this module only ever receives an
 * already-resolved `TenantDatabaseTarget`, it never looks up Control Plane state itself.
 */
export interface TenantDatabaseConnectionManager {
  withTenantDatabase<T>(
    target: TenantDatabaseTarget,
    operation: (db: TenantDatabase) => Promise<T>,
  ): Promise<T>;

  /**
   * Closes and discards any cached connection for this tenant, if one exists. The next
   * `withTenantDatabase` call for the same tenant opens a fresh one. Exists so a future
   * credential rotation (not implemented yet) has somewhere to invalidate a pool that was
   * opened with the now-stale password — see ARCHITECTURE.md.
   */
  invalidate(tenantId: string): Promise<void>;

  /** Closes every cached connection. Call once during graceful shutdown. */
  close(): Promise<void>;
}
