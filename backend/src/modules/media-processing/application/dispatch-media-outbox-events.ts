import {
  PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE,
  propertyMediaProcessingRequestedPayloadSchema,
} from "../../properties/domain/property-media-processing-event.js";

export interface ClaimedMediaOutboxEvent {
  id: string;
  payload: unknown;
}

export interface ClaimEligibleMediaOutboxEventsInput {
  batchSize: number;
  leaseSeconds: number;
}

/**
 * Persistence port for the media outbox dispatcher, scoped to a single already-resolved tenant
 * database (Prompt 031, ADR-009) — mirrors `ProvisioningDispatchRepository` (ADR-002) applied
 * per tenant instead of against one Control Plane table. Deliberately narrow — no generic
 * outbox repository — and silent about *how* atomicity/locking is achieved; that is an
 * infrastructure concern.
 */
export interface MediaOutboxDispatchRepository {
  /**
   * Claims up to `batchSize` `PROPERTY_MEDIA_PROCESSING_REQUESTED` events that are not yet
   * dispatched, not yet processed, and not permanently failed — inside a short PostgreSQL
   * transaction (`FOR UPDATE SKIP LOCKED`, this task, section 14). FIFO within this tenant
   * (`created_at ASC, id ASC`, section 36).
   */
  claimEligibleEvents(input: ClaimEligibleMediaOutboxEventsInput): Promise<ClaimedMediaOutboxEvent[]>;
  /** Confirms a successful publish (transport only — never `processed_at`, section 21). No-op
   * if the event was already dispatched. */
  markDispatched(outboxEventId: string): Promise<void>;
  /** Releases a claim after a failed publish attempt, keeping the claim timestamp for
   * observability — same shape as the provisioning dispatcher's own Step 5 (ADR-002). */
  releaseLease(outboxEventId: string): Promise<void>;
  /** Marks an event permanently unusable (e.g. a payload that fails its Zod shape check) —
   * never retried by lease expiry (section 30). `reason` is always a fixed, safe message. */
  markDispatchFailed(outboxEventId: string, reason: string): Promise<void>;
}

export interface DispatchMediaOutboxJob {
  tenantId: string;
  outboxEventId: string;
  propertyId: string;
  mediaId: string;
}

/** Publishing port. The BullMQ adapter lives in infrastructure so this stays mockable. */
export interface MediaOutboxJobPublisher {
  publish(job: DispatchMediaOutboxJob): Promise<void>;
}

export interface MediaOutboxEventDispatchResult {
  outboxEventId: string;
  outcome: "dispatched" | "failed" | "invalid";
  error?: unknown;
}

export interface TenantOutboxDispatchSummary {
  claimedCount: number;
  results: MediaOutboxEventDispatchResult[];
}

/**
 * Runs a single dispatch cycle against ONE already-resolved tenant database: claim eligible
 * events, validate each payload, publish, confirm. Pure orchestration — no logging, no loop, no
 * timers, no tenant discovery — so it can be exercised in tests without a real Control Plane or
 * BullMQ (Prompt 031, mirrors `dispatchProvisioningJobsOnce`, ADR-002).
 */
export async function dispatchTenantMediaOutboxOnce(
  tenantId: string,
  repository: MediaOutboxDispatchRepository,
  publisher: MediaOutboxJobPublisher,
  options: ClaimEligibleMediaOutboxEventsInput,
): Promise<TenantOutboxDispatchSummary> {
  const claimed = await repository.claimEligibleEvents(options);

  const results: MediaOutboxEventDispatchResult[] = [];

  for (const event of claimed) {
    const parsed = propertyMediaProcessingRequestedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      // Permanent, never transient (this task, section 25/30) — retrying can never make a
      // structurally invalid payload valid. Never sends anything to BullMQ for this event.
      await repository.markDispatchFailed(
        event.id,
        `Invalid ${PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE} payload`,
      );
      results.push({ outboxEventId: event.id, outcome: "invalid" });
      continue;
    }

    try {
      await publisher.publish({
        tenantId,
        outboxEventId: event.id,
        propertyId: parsed.data.propertyId,
        mediaId: parsed.data.mediaId,
      });
      await repository.markDispatched(event.id);
      results.push({ outboxEventId: event.id, outcome: "dispatched" });
    } catch (error) {
      results.push({ outboxEventId: event.id, outcome: "failed", error });
      // Best-effort — if releasing the lease also fails, the event self-heals once
      // dispatch_lease_until naturally expires (same principle as ADR-002 Step 5); never let
      // one event's failure stop the rest of the batch from being processed.
      await repository.releaseLease(event.id).catch(() => undefined);
    }
  }

  return { claimedCount: claimed.length, results };
}
