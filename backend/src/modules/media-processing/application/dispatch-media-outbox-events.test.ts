import { describe, expect, it } from "vitest";

import {
  dispatchTenantMediaOutboxOnce,
  type ClaimedMediaOutboxEvent,
  type ClaimEligibleMediaOutboxEventsInput,
  type DispatchMediaOutboxJob,
  type MediaOutboxDispatchRepository,
  type MediaOutboxJobPublisher,
} from "./dispatch-media-outbox-events.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const VALID_EVENT: ClaimedMediaOutboxEvent = {
  id: "22222222-2222-4222-8222-222222222222",
  payload: {
    propertyId: "33333333-3333-4333-8333-333333333333",
    mediaId: "44444444-4444-4444-8444-444444444444",
  },
};

function fakeRepository(overrides: Partial<MediaOutboxDispatchRepository> = {}): MediaOutboxDispatchRepository {
  return {
    claimEligibleEvents: async () => [],
    markDispatched: async () => undefined,
    releaseLease: async () => undefined,
    markDispatchFailed: async () => undefined,
    ...overrides,
  };
}

function fakePublisher(overrides: Partial<MediaOutboxJobPublisher> = {}): MediaOutboxJobPublisher {
  return {
    publish: async () => undefined,
    ...overrides,
  };
}

const OPTIONS: ClaimEligibleMediaOutboxEventsInput = { batchSize: 20, leaseSeconds: 30 };

describe("dispatchTenantMediaOutboxOnce", () => {
  it("publishes each claimed event and marks it dispatched, reporting outcome 'dispatched'", async () => {
    const published: DispatchMediaOutboxJob[] = [];
    const markedDispatched: string[] = [];
    const repository = fakeRepository({
      claimEligibleEvents: async () => [VALID_EVENT],
      markDispatched: async (id) => {
        markedDispatched.push(id);
      },
    });
    const publisher = fakePublisher({
      publish: async (job) => {
        published.push(job);
      },
    });

    const summary = await dispatchTenantMediaOutboxOnce(TENANT_ID, repository, publisher, OPTIONS);

    expect(summary).toEqual({
      claimedCount: 1,
      results: [{ outboxEventId: VALID_EVENT.id, outcome: "dispatched" }],
    });
    expect(published).toEqual([
      {
        tenantId: TENANT_ID,
        outboxEventId: VALID_EVENT.id,
        propertyId: "33333333-3333-4333-8333-333333333333",
        mediaId: "44444444-4444-4444-8444-444444444444",
      },
    ]);
    expect(markedDispatched).toEqual([VALID_EVENT.id]);
  });

  it("returns an empty summary when nothing is claimed, never calling the publisher", async () => {
    const publishCalls: DispatchMediaOutboxJob[] = [];
    const repository = fakeRepository({ claimEligibleEvents: async () => [] });
    const publisher = fakePublisher({
      publish: async (job) => {
        publishCalls.push(job);
      },
    });

    const summary = await dispatchTenantMediaOutboxOnce(TENANT_ID, repository, publisher, OPTIONS);

    expect(summary).toEqual({ claimedCount: 0, results: [] });
    expect(publishCalls).toHaveLength(0);
  });

  const invalidPayloadCases: [string, unknown][] = [
    ["missing mediaId", { propertyId: "33333333-3333-4333-8333-333333333333" }],
    ["non-UUID propertyId", { propertyId: "not-a-uuid", mediaId: "44444444-4444-4444-8444-444444444444" }],
    ["an extra unexpected field", { ...(VALID_EVENT.payload as object), extra: "leaked" }],
    ["a non-object payload", "not-an-object"],
    ["null payload", null],
  ];

  it.each(invalidPayloadCases)("marks an event with an invalid payload (%s) as dispatch-failed, never publishing", async (_label, payload) => {
    const publishCalls: DispatchMediaOutboxJob[] = [];
    const failedCalls: { id: string; reason: string }[] = [];
    const repository = fakeRepository({
      claimEligibleEvents: async () => [{ id: VALID_EVENT.id, payload }],
      markDispatchFailed: async (id, reason) => {
        failedCalls.push({ id, reason });
      },
    });
    const publisher = fakePublisher({
      publish: async (job) => {
        publishCalls.push(job);
      },
    });

    const summary = await dispatchTenantMediaOutboxOnce(TENANT_ID, repository, publisher, OPTIONS);

    expect(summary.results).toEqual([{ outboxEventId: VALID_EVENT.id, outcome: "invalid" }]);
    expect(publishCalls).toHaveLength(0);
    expect(failedCalls).toEqual([
      { id: VALID_EVENT.id, reason: "Invalid PROPERTY_MEDIA_PROCESSING_REQUESTED payload" },
    ]);
    // Never a stack trace or the raw payload in the stored reason (this task, section 28).
    expect(failedCalls[0]?.reason).not.toContain("not-a-uuid");
  });

  it("releases the lease and reports 'failed' when the publisher throws, without marking dispatched", async () => {
    const releaseCalls: string[] = [];
    const dispatchedCalls: string[] = [];
    const publishError = new Error("Redis unreachable");
    const repository = fakeRepository({
      claimEligibleEvents: async () => [VALID_EVENT],
      releaseLease: async (id) => {
        releaseCalls.push(id);
      },
      markDispatched: async (id) => {
        dispatchedCalls.push(id);
      },
    });
    const publisher = fakePublisher({
      publish: async () => {
        throw publishError;
      },
    });

    const summary = await dispatchTenantMediaOutboxOnce(TENANT_ID, repository, publisher, OPTIONS);

    expect(summary.results).toEqual([{ outboxEventId: VALID_EVENT.id, outcome: "failed", error: publishError }]);
    expect(releaseCalls).toEqual([VALID_EVENT.id]);
    expect(dispatchedCalls).toHaveLength(0);
  });

  it("continues to the next event even when releasing the lease also fails", async () => {
    const repository = fakeRepository({
      claimEligibleEvents: async () => [VALID_EVENT],
      releaseLease: async () => {
        throw new Error("DB unreachable");
      },
    });
    const publisher = fakePublisher({
      publish: async () => {
        throw new Error("Redis unreachable");
      },
    });

    await expect(dispatchTenantMediaOutboxOnce(TENANT_ID, repository, publisher, OPTIONS)).resolves.toEqual({
      claimedCount: 1,
      results: [{ outboxEventId: VALID_EVENT.id, outcome: "failed", error: expect.any(Error) }],
    });
  });

  it("processes multiple claimed events independently, one failure never blocking another", async () => {
    const secondEvent: ClaimedMediaOutboxEvent = {
      id: "55555555-5555-4555-8555-555555555555",
      payload: {
        propertyId: "33333333-3333-4333-8333-333333333333",
        mediaId: "66666666-6666-4666-8666-666666666666",
      },
    };
    const publishCalls: DispatchMediaOutboxJob[] = [];
    const repository = fakeRepository({
      claimEligibleEvents: async () => [VALID_EVENT, secondEvent],
    });
    const publisher = fakePublisher({
      publish: async (job) => {
        if (job.outboxEventId === VALID_EVENT.id) {
          throw new Error("boom");
        }
        publishCalls.push(job);
      },
    });

    const summary = await dispatchTenantMediaOutboxOnce(TENANT_ID, repository, publisher, OPTIONS);

    expect(summary.results.map((r) => r.outcome)).toEqual(["failed", "dispatched"]);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]?.outboxEventId).toBe(secondEvent.id);
  });
});
