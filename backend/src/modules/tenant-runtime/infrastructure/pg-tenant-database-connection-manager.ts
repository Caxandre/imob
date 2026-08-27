import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as tenantSchema from "../../../infrastructure/database/tenant/schema.js";
import type { TenantDatabaseCredentialResolver } from "../../provisioning/application/tenant-database-credential-resolver.js";
import type {
  TenantDatabase,
  TenantDatabaseConnectionManager,
} from "../application/tenant-database-connection-manager.js";
import type { TenantDatabaseTarget } from "../application/tenant-database-resolver.js";

interface PoolEntry {
  pool: Pool;
  db: TenantDatabase;
}

export interface PgTenantDatabaseConnectionManagerOptions {
  /** Resolves the *tenant application* credential — never accepts a cluster admin resolver;
   *  there is no code path in this module that could reach for one instead (CLAUDE.md). */
  credentialResolver: TenantDatabaseCredentialResolver;
  /** Upper bound on how many tenant pools are cached at once. Once reached, the
   *  least-recently-used pool is closed to make room — this manager never opens an unbounded
   *  number of pools for an unbounded number of tenants. Default: 50. */
  maxPools?: number;
  /** Passed straight to each per-tenant `pg.Pool` (`idleTimeoutMillis`) — trims unused
   *  physical connections *within* a tenant's own pool. Does not by itself remove the pool
   *  entry from this manager's cache; see ARCHITECTURE.md for why proactive per-tenant entry
   *  eviction (as opposed to the capacity-based eviction above) is out of scope for this
   *  task. Default: 30_000. */
  idleTimeoutMillis?: number;
  /** Passed straight to each per-tenant `pg.Pool` (`max`) — how many physical connections a
   *  single tenant's pool may open concurrently. Default: 5. */
  maxConnectionsPerPool?: number;
}

const DEFAULT_MAX_POOLS = 50;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS_PER_POOL = 5;

/**
 * Real, PostgreSQL-backed `TenantDatabaseConnectionManager`: one lazily-created `pg.Pool` per
 * tenant, cached by `tenantId`, capped at `maxPools` with least-recently-used eviction — never
 * a single shared `Pool` switching database/credential per call (each tenant's pool carries
 * its own fixed connection config, set once at creation). Always opens with the credential
 * `credentialResolver` resolves from `target.secretReference` — the tenant application
 * credential, never the cluster admin credential. Credential resolution happens, and can
 * fail, before any `pg.Pool`/connection is ever constructed for a new tenant — a missing or
 * invalid secret never results in a connection attempt.
 */
export function createPgTenantDatabaseConnectionManager(
  options: PgTenantDatabaseConnectionManagerOptions,
): TenantDatabaseConnectionManager {
  const maxPools = options.maxPools ?? DEFAULT_MAX_POOLS;
  const idleTimeoutMillis = options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxConnectionsPerPool = options.maxConnectionsPerPool ?? DEFAULT_MAX_CONNECTIONS_PER_POOL;

  // Map iteration order is insertion order; re-inserting a key on reuse (delete + set) below
  // keeps that order least-recently-used → most-recently-used, so the first entry is always
  // the eviction candidate — no separate timestamp bookkeeping needed.
  const pools = new Map<string, PoolEntry>();

  async function getOrCreatePool(target: TenantDatabaseTarget): Promise<PoolEntry> {
    const existing = pools.get(target.tenantId);
    if (existing) {
      pools.delete(target.tenantId);
      pools.set(target.tenantId, existing);
      return existing;
    }

    if (pools.size >= maxPools) {
      const oldestKey = pools.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = pools.get(oldestKey);
        pools.delete(oldestKey);
        if (oldest) {
          await oldest.pool.end();
        }
      }
    }

    const credential = await options.credentialResolver.resolve(target.secretReference);

    const pool = new Pool({
      host: target.host,
      port: target.port,
      database: target.databaseName,
      user: credential.username,
      password: credential.password,
      max: maxConnectionsPerPool,
      idleTimeoutMillis,
    });
    const db = drizzle(pool, { schema: tenantSchema });
    const entry: PoolEntry = { pool, db };
    pools.set(target.tenantId, entry);
    return entry;
  }

  return {
    async withTenantDatabase<T>(
      target: TenantDatabaseTarget,
      operation: (db: TenantDatabase) => Promise<T>,
    ): Promise<T> {
      const entry = await getOrCreatePool(target);
      return operation(entry.db);
    },

    async invalidate(tenantId: string): Promise<void> {
      const entry = pools.get(tenantId);
      if (!entry) {
        return;
      }
      pools.delete(tenantId);
      await entry.pool.end();
    },

    async close(): Promise<void> {
      const entries = [...pools.values()];
      pools.clear();
      await Promise.all(entries.map((entry) => entry.pool.end()));
    },
  };
}
