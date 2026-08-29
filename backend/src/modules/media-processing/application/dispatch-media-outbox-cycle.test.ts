import { describe, expect, it } from "vitest";

import type { TenantDatabase, TenantDatabaseConnectionManager } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { TenantDatabaseResolver, TenantDatabaseTarget } from "../../tenant-runtime/application/tenant-database-resolver.js";
import { TenantNotReadyError } from "../../tenant-runtime/application/tenant-database-resolver.js";
import type { ListReadyTenantIdsInput, TenantDiscovery } from "../../tenant-runtime/application/tenant-discovery.js";
import {
  runMediaOutboxDispatchCycleOnce,
  type MediaOutboxDispatchCycleDeps,
  type MediaOutboxDispatchCycleOptions,
} from "./dispatch-media-outbox-cycle.js";
import type { MediaOutboxDispatchRepository, MediaOutboxJobPublisher } from "./dispatch-media-outbox-events.js";

function fakeTarget(tenantId: string): TenantDatabaseTarget {
  return {
    tenantId,
    clusterId: "cluster-1",
    host: "localhost",
    port: 5433,
    databaseName: `tenant_${tenantId}`,
    secretReference: `tenant-databases/${tenantId}`,
    schemaVersion: 1,
  };
}

function fakeDiscovery(tenantIds: string[]): TenantDiscovery {
  return {
    async listReadyTenantIds({ after, limit }: ListReadyTenantIdsInput): Promise<string[]> {
      const start = after === undefined ? 0 : tenantIds.indexOf(after) + 1;
      return tenantIds.slice(start, start + limit);
    },
  };
}

function fakeResolver(overrides: Partial<TenantDatabaseResolver> = {}): TenantDatabaseResolver {
  return {
    resolve: async (tenantId: string) => fakeTarget(tenantId),
    ...overrides,
  };
}

function fakeConnectionManager(): TenantDatabaseConnectionManager {
  return {
    withTenantDatabase: async (_target, operation) => operation({} as TenantDatabase),
    invalidate: async () => undefined,
    close: async () => undefined,
  };
}

function fakeRepositoryWithEvents(count: number): MediaOutboxDispatchRepository {
  let claimed = false;
  return {
    claimEligibleEvents: async () => {
      if (claimed) return [];
      claimed = true;
      return Array.from({ length: count }, (_unused, i) => ({
        id: `event-${i}`,
        payload: { propertyId: "33333333-3333-4333-8333-333333333333", mediaId: `44444444-4444-4444-8444-44444444444${i}` },
      }));
    },
    markDispatched: async () => undefined,
    releaseLease: async () => undefined,
    markDispatchFailed: async () => undefined,
  };
}

function fakePublisher(overrides: Partial<MediaOutboxJobPublisher> = {}): MediaOutboxJobPublisher {
  return {
    publish: async () => undefined,
    ...overrides,
  };
}

const OPTIONS: MediaOutboxDispatchCycleOptions = {
  tenantBatchSize: 25,
  eventBatchSize: 20,
  leaseSeconds: 30,
  concurrency: 5,
};

describe("runMediaOutboxDispatchCycleOnce", () => {
  it("dispatches every discovered tenant independently", async () => {
    const tenantIds = ["tenant-a", "tenant-b", "tenant-c"];
    const dispatchedFor: string[] = [];
    const deps: MediaOutboxDispatchCycleDeps = {
      tenantDiscovery: fakeDiscovery(tenantIds),
      tenantDatabaseResolver: fakeResolver(),
      tenantDatabaseConnectionManager: fakeConnectionManager(),
      createRepository: () => fakeRepositoryWithEvents(1),
      publisher: fakePublisher({
        publish: async (job) => {
          dispatchedFor.push(job.tenantId);
        },
      }),
    };

    const summary = await runMediaOutboxDispatchCycleOnce(deps, undefined, OPTIONS);

    expect(summary.tenantIds).toEqual(tenantIds);
    expect(summary.tenantResults.every((r) => r.outcome === "dispatched")).toBe(true);
    expect(dispatchedFor.sort()).toEqual(tenantIds.sort());
  });

  it("isolates a tenant resolution failure — other tenants are still dispatched", async () => {
    const tenantIds = ["tenant-a", "tenant-b"];
    const dispatchedFor: string[] = [];
    const deps: MediaOutboxDispatchCycleDeps = {
      tenantDiscovery: fakeDiscovery(tenantIds),
      tenantDatabaseResolver: fakeResolver({
        resolve: async (tenantId) => {
          if (tenantId === "tenant-a") {
            throw new TenantNotReadyError(tenantId, "SUSPENDED");
          }
          return fakeTarget(tenantId);
        },
      }),
      tenantDatabaseConnectionManager: fakeConnectionManager(),
      createRepository: () => fakeRepositoryWithEvents(1),
      publisher: fakePublisher({
        publish: async (job) => {
          dispatchedFor.push(job.tenantId);
        },
      }),
    };

    const summary = await runMediaOutboxDispatchCycleOnce(deps, undefined, OPTIONS);

    const a = summary.tenantResults.find((r) => r.tenantId === "tenant-a");
    const b = summary.tenantResults.find((r) => r.tenantId === "tenant-b");
    expect(a?.outcome).toBe("tenant-unavailable");
    expect(a?.error).toBeInstanceOf(TenantNotReadyError);
    expect(b?.outcome).toBe("dispatched");
    expect(dispatchedFor).toEqual(["tenant-b"]);
  });

  it("isolates a tenant connection failure — other tenants are still dispatched", async () => {
    const tenantIds = ["tenant-a", "tenant-b"];
    const dispatchedFor: string[] = [];
    const connectionManager: TenantDatabaseConnectionManager = {
      withTenantDatabase: async (target, operation) => {
        if (target.tenantId === "tenant-a") {
          throw new Error("connection refused");
        }
        return operation({} as TenantDatabase);
      },
      invalidate: async () => undefined,
      close: async () => undefined,
    };
    const deps: MediaOutboxDispatchCycleDeps = {
      tenantDiscovery: fakeDiscovery(tenantIds),
      tenantDatabaseResolver: fakeResolver(),
      tenantDatabaseConnectionManager: connectionManager,
      createRepository: () => fakeRepositoryWithEvents(1),
      publisher: fakePublisher({
        publish: async (job) => {
          dispatchedFor.push(job.tenantId);
        },
      }),
    };

    const summary = await runMediaOutboxDispatchCycleOnce(deps, undefined, OPTIONS);

    expect(summary.tenantResults.find((r) => r.tenantId === "tenant-a")?.outcome).toBe("tenant-unavailable");
    expect(dispatchedFor).toEqual(["tenant-b"]);
  });

  it("bounds concurrent tenant dispatches to the configured limit", async () => {
    const tenantIds = ["t1", "t2", "t3", "t4", "t5"];
    let inFlight = 0;
    let maxInFlight = 0;
    const connectionManager: TenantDatabaseConnectionManager = {
      withTenantDatabase: async (_target, operation) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await operation({} as TenantDatabase);
        } finally {
          inFlight -= 1;
        }
      },
      invalidate: async () => undefined,
      close: async () => undefined,
    };
    const deps: MediaOutboxDispatchCycleDeps = {
      tenantDiscovery: fakeDiscovery(tenantIds),
      tenantDatabaseResolver: fakeResolver(),
      tenantDatabaseConnectionManager: connectionManager,
      createRepository: () => fakeRepositoryWithEvents(0),
      publisher: fakePublisher(),
    };

    await runMediaOutboxDispatchCycleOnce(deps, undefined, { ...OPTIONS, concurrency: 2 });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("advances the cursor to the last tenant id when a full page is returned", async () => {
    const tenantIds = Array.from({ length: 5 }, (_unused, i) => `tenant-${i}`);
    const deps: MediaOutboxDispatchCycleDeps = {
      tenantDiscovery: fakeDiscovery(tenantIds),
      tenantDatabaseResolver: fakeResolver(),
      tenantDatabaseConnectionManager: fakeConnectionManager(),
      createRepository: () => fakeRepositoryWithEvents(0),
      publisher: fakePublisher(),
    };

    const summary = await runMediaOutboxDispatchCycleOnce(deps, undefined, { ...OPTIONS, tenantBatchSize: 5 });

    expect(summary.nextCursor).toBe("tenant-4");
  });

  it("resets the cursor to undefined when fewer than a full page is returned — end of the list reached", async () => {
    const tenantIds = ["tenant-0", "tenant-1"];
    const deps: MediaOutboxDispatchCycleDeps = {
      tenantDiscovery: fakeDiscovery(tenantIds),
      tenantDatabaseResolver: fakeResolver(),
      tenantDatabaseConnectionManager: fakeConnectionManager(),
      createRepository: () => fakeRepositoryWithEvents(0),
      publisher: fakePublisher(),
    };

    const summary = await runMediaOutboxDispatchCycleOnce(deps, undefined, { ...OPTIONS, tenantBatchSize: 25 });

    expect(summary.nextCursor).toBeUndefined();
  });
});
