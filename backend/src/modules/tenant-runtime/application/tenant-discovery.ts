export interface ListReadyTenantIdsInput {
  /**
   * Exclusive lower bound (this task, section 6/7) — only tenant ids strictly greater than this
   * are returned, ordered by `tenants.id` ASC. `undefined` starts from the beginning. The
   * caller (a dispatcher's own cycle loop) is expected to hold this cursor only in memory,
   * never persist it: losing it just restarts the scan from the beginning next cycle, which
   * never loses work — the durable source of truth is the pending work itself (e.g. outbox
   * rows), not the scan position (Prompt 031, section 7).
   */
  after?: string;
  limit: number;
}

/**
 * Lists tenant ids currently eligible for cross-tenant background work against their own
 * database — `tenants.status = READY`, `tenant_databases.status = READY`,
 * `database_clusters.status = ACTIVE` (Prompt 031, section 4) — the same three-way eligibility
 * `TenantDatabaseResolver.resolve()` checks for one tenant, but as a paginated listing. A tenant
 * `PROVISIONING`/`FAILED`/`SUSPENDED`, a missing/non-READY `tenant_databases` row, or an
 * `INACTIVE` cluster is never returned. Ordered by `tenants.id` ASC so a cursor (`after`) gives
 * a stable, resumable page even as tenants are added/removed between cycles.
 */
export interface TenantDiscovery {
  listReadyTenantIds(input: ListReadyTenantIdsInput): Promise<string[]>;
}
