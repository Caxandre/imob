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
