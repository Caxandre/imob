import type { TenantDatabase } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { TenantDatabaseConnectionManager } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { TenantDatabaseResolver } from "../../tenant-runtime/application/tenant-database-resolver.js";
import type { TenantDiscovery } from "../../tenant-runtime/application/tenant-discovery.js";
import {
  dispatchTenantMediaOutboxOnce,
  type MediaOutboxDispatchRepository,
  type MediaOutboxJobPublisher,
  type TenantOutboxDispatchSummary,
} from "./dispatch-media-outbox-events.js";

export interface MediaOutboxDispatchCycleOptions {
  tenantBatchSize: number;
  eventBatchSize: number;
  leaseSeconds: number;
  concurrency: number;
}

export interface TenantDispatchOutcome {
  tenantId: string;
  outcome: "dispatched" | "tenant-unavailable";
  summary?: TenantOutboxDispatchSummary;
  error?: unknown;
}

export interface MediaOutboxDispatchCycleSummary {
  tenantIds: string[];
  /** `undefined` means the end of the eligible-tenant list was reached this cycle — the next
   * cycle should start over from the beginning (this task, section 6). */
  nextCursor: string | undefined;
  tenantResults: TenantDispatchOutcome[];
}

export interface MediaOutboxDispatchCycleDeps {
  tenantDiscovery: TenantDiscovery;
  tenantDatabaseResolver: TenantDatabaseResolver;
  tenantDatabaseConnectionManager: TenantDatabaseConnectionManager;
  createRepository: (db: TenantDatabase) => MediaOutboxDispatchRepository;
  publisher: MediaOutboxJobPublisher;
}

/**
 * Runs one full dispatch cycle: discover a page of eligible tenants from the Control Plane
 * (`TenantDiscovery`), then dispatch each tenant's own pending media outbox independently,
 * bounded by `concurrency` (this task, section 34 — a small in-house chunking loop, no new
 * dependency). A tenant becoming temporarily unreachable (secret gap, `INACTIVE` cluster,
 * connection failure, ...) is caught and recorded per tenant — it never aborts the rest of the
 * cycle (section 31/49/61: failure isolation). Pure orchestration, no logging/timers/loop — the
 * entrypoint (`src/workers/media-outbox-dispatcher.ts`) owns those.
 */
export async function runMediaOutboxDispatchCycleOnce(
  deps: MediaOutboxDispatchCycleDeps,
  cursor: string | undefined,
  options: MediaOutboxDispatchCycleOptions,
): Promise<MediaOutboxDispatchCycleSummary> {
  const tenantIds = await deps.tenantDiscovery.listReadyTenantIds({
    after: cursor,
    limit: options.tenantBatchSize,
  });

  const tenantResults: TenantDispatchOutcome[] = [];

  for (let start = 0; start < tenantIds.length; start += options.concurrency) {
    const chunk = tenantIds.slice(start, start + options.concurrency);
    const chunkResults = await Promise.all(
      chunk.map((tenantId): Promise<TenantDispatchOutcome> => dispatchOneTenant(deps, tenantId, options)),
    );
    tenantResults.push(...chunkResults);
  }

  // A full page might mean more remain; anything shorter means this page reached the end of
  // the eligible list — restart from the beginning next cycle rather than tracking a stale tail.
  const nextCursor = tenantIds.length === options.tenantBatchSize ? tenantIds[tenantIds.length - 1] : undefined;

  return { tenantIds, nextCursor, tenantResults };
}

async function dispatchOneTenant(
  deps: MediaOutboxDispatchCycleDeps,
  tenantId: string,
  options: MediaOutboxDispatchCycleOptions,
): Promise<TenantDispatchOutcome> {
  try {
    // Re-resolved every cycle, never cached across cycles (this task, section 32) — the same
    // "never trust a previously-resolved state" discipline TenantDatabaseResolver itself
    // documents: Control Plane state (tenant SUSPENDED, cluster turned INACTIVE, ...) can
    // change between discovery and this dispatch attempt.
    const target = await deps.tenantDatabaseResolver.resolve(tenantId);
    const summary = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, (db) => {
      const repository = deps.createRepository(db);
      return dispatchTenantMediaOutboxOnce(tenantId, repository, deps.publisher, {
        batchSize: options.eventBatchSize,
        leaseSeconds: options.leaseSeconds,
      });
    });
    return { tenantId, outcome: "dispatched", summary };
  } catch (error) {
    return { tenantId, outcome: "tenant-unavailable", error };
  }
}
