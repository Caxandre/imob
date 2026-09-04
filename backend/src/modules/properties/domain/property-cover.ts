import type { PropertyMediaProcessingStatus } from "./property-media.js";
import type { PropertyMediaVariant } from "./property-media-variant.js";
import type { Property } from "./property.js";

/**
 * Cover-only variant projection (Prompt 037A) — deliberately just `thumbnail`/`card`, never
 * `detail` (this task, section 5): the catalog only ever renders a grid card, never the largest
 * rendition. A narrower sibling of `PropertyMediaVariantSet` (`property-media-variant.ts`,
 * Prompt 035's three-key set for the full media detail endpoint) — not reused directly, since
 * that type's third key (`detail`) would have no correct value to hold here.
 */
export interface PropertyCoverVariantSet {
  thumbnail: PropertyMediaVariant | null;
  card: PropertyMediaVariant | null;
}

/**
 * Summarized cover media for one property, as surfaced by `GET /api/v1/properties` (Prompt
 * 037A) — never the full gallery. Selected preferring `property_media.is_cover = true`; when no
 * row has it set (a defensive fallback, never assumed impossible — this task, sections 8/19),
 * the first by `position ASC, id ASC` wins instead. See
 * `drizzle-property-repository.ts` for the actual selection query.
 */
export interface PropertyCover {
  id: string;
  publicUrl: string;
  processingStatus: PropertyMediaProcessingStatus;
  variants: PropertyCoverVariantSet;
}

/**
 * `Property` plus its cover (Prompt 037A) — what `PropertyRepository.list()` returns.
 * `cover` is `null` exactly when the property has no `property_media` row at all (section 34) —
 * never an artificial object, never thrown as an error. Every other `PropertyRepository` method
 * (`create`/`findById`/`update`/`archive`) keeps returning plain `Property` — this task
 * deliberately touches only the list endpoint (section 23/24).
 */
export interface PropertyWithCover extends Property {
  cover: PropertyCover | null;
}
