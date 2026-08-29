import type { PropertyMediaVariantName } from "../../properties/domain/property-media-variant.js";

export interface PropertyMediaProcessingContext {
  mediaId: string;
  propertyId: string;
  /** The original's R2 object key — the only thing the worker needs to download it. */
  objectKey: string;
  mimeType: string;
}

/**
 * Every state `loadContext` needs to distinguish before any R2/`sharp` work starts (Prompt 032,
 * sections 38-44):
 * - `ready`: safe to process — the outbox event is well-formed, unprocessed, and its media
 *   exists and belongs to the given property.
 * - `already-processed`: the outbox event's `processed_at` is already set — a BullMQ replay of
 *   an already-completed job (section 40). No-op, never reprocessed.
 * - `media-missing`: the outbox event is valid and unprocessed, but its `property_media` row no
 *   longer exists — the media was deleted after the job was enqueued (section 43). Never an
 *   error; the caller marks the event processed and treats the job as obsolete.
 * - `invalid-event`: the outbox event referenced by `outboxEventId` doesn't exist, doesn't match
 *   `aggregate_type=PROPERTY_MEDIA`/`event_type=PROPERTY_MEDIA_PROCESSING_REQUESTED`/
 *   `aggregate_id=mediaId`, or the media it does reference belongs to a different property than
 *   the job payload claims (section 39/44) — a permanent, safe-to-fail condition; never
 *   retried.
 */
export type LoadPropertyMediaProcessingContextResult =
  | { outcome: "ready"; context: PropertyMediaProcessingContext }
  | { outcome: "already-processed" }
  | { outcome: "media-missing" }
  | { outcome: "invalid-event" };

/** Already uploaded to R2 by the caller (`process-property-media-job.ts`) before
 * `finalizeReady()` is ever invoked — this repository never touches `ObjectStorage` itself. */
export interface UploadedPropertyMediaVariant {
  variant: PropertyMediaVariantName;
  objectKey: string;
  publicUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/** `"media-missing"` here means the media was deleted *between* `loadContext()` returning
 * `ready` and this call — a real, if narrow, race (section 62) — never a bug in the caller. */
export type FinalizePropertyMediaResult = "finalized" | "media-missing";

/**
 * Persistence port for the media processing worker (Prompt 032, ADR-008) — everything it needs
 * to validate one outbox event, then atomically finalize its outcome, scoped to an
 * already-resolved tenant database (same convention as every other repository in this
 * codebase). Deliberately separate from `PropertyMediaRepository` (Prompt 027/028): that port
 * serves the HTTP-facing gallery operations (create/reorder/cover/delete); this one serves only
 * the worker's own read-validate-finalize shape, spanning `property_media`,
 * `property_media_variants`, and `outbox_events` together.
 */
export interface PropertyMediaProcessingRepository {
  loadContext(input: {
    outboxEventId: string;
    propertyId: string;
    mediaId: string;
  }): Promise<LoadPropertyMediaProcessingContextResult>;

  /** Marks the outbox event processed without touching `property_media` at all — the
   * "job obsolete, media already deleted" case (section 43). Idempotent. */
  markObsoleteProcessed(outboxEventId: string): Promise<void>;

  /**
   * Upserts every variant (`UNIQUE(property_media_id, variant)`, section 50/51), sets
   * `property_media.processing_status = READY`, and marks the outbox event processed — all in
   * one transaction (section 49/52): a media is never observably `READY` with a variant
   * missing from the database, and the outbox event is never `processed_at` without the
   * variants that justify it existing. Re-checks that the media still exists before writing
   * anything (section 62) — see {@link FinalizePropertyMediaResult}.
   */
  finalizeReady(input: {
    outboxEventId: string;
    mediaId: string;
    variants: UploadedPropertyMediaVariant[];
  }): Promise<FinalizePropertyMediaResult>;

  /**
   * Sets `property_media.processing_status = FAILED` and marks the outbox event processed —
   * one transaction (section 55). Never creates variant rows. Re-checks that the media still
   * exists before writing anything (section 62).
   */
  finalizeFailed(input: { outboxEventId: string; mediaId: string }): Promise<FinalizePropertyMediaResult>;
}
