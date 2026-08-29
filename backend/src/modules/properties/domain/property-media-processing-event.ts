import { z } from "zod";

/**
 * The single `outbox_events` shape this module writes (Prompt 030, ADR-008 "Queue and worker").
 * `outbox_events` already exists in the Tenant Data Plane schema (every tenant database, since
 * the first migration) — this task reuses it as the durable, transactional intent that a
 * property media upload needs processing, instead of inventing a second, media-specific
 * outbox/jobs table (this task, section 49). Centralized here so `aggregate_type`/`event_type`
 * are never spelled as loose string literals at each call site (section 50).
 */
export const PROPERTY_MEDIA_AGGREGATE_TYPE = "PROPERTY_MEDIA";

export const PROPERTY_MEDIA_PROCESSING_REQUESTED_EVENT_TYPE = "PROPERTY_MEDIA_PROCESSING_REQUESTED";

/**
 * Deliberately minimal (this task, section 41/46) — no credentials, no object key, no bytes.
 * `tenantId` is never included: the event already lives inside that one tenant's own database
 * (ADR-001), so it would be redundant — a future outbox dispatcher reading this row already
 * knows which tenant database it is connected to (section 68).
 */
export interface PropertyMediaProcessingRequestedPayload {
  propertyId: string;
  mediaId: string;
}

/**
 * `outbox_events.payload` is `jsonb` — an untrusted boundary from the reader's point of view
 * (Prompt 031, ADR-009, section 24), the same reasoning already applied to `SecretStore`
 * payloads (CLAUDE.md): never trust the shape just because this same codebase is the only thing
 * that ever wrote it. The media outbox dispatcher parses every claimed event's payload through
 * this schema before ever calling `queue.add()` — an event that fails this check is a permanent,
 * not transient, condition (see `dispatch_failed_at`), since retrying can never make a
 * structurally invalid payload valid.
 */
export const propertyMediaProcessingRequestedPayloadSchema = z
  .object({
    propertyId: z.uuid(),
    mediaId: z.uuid(),
  })
  .strict();
