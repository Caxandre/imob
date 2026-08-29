/**
 * Derived renditions of one `property_media` original (Prompt 030/032, ADR-008) — persisted in
 * `property_media_variants` (Tenant Data Plane, no `tenant_id`, ADR-001). `THUMBNAIL`/`CARD`/
 * `DETAIL` match the enum in `infrastructure/database/tenant/schema.ts` exactly; the names are
 * never repeated as loose string literals elsewhere in this module (this task, section 9).
 */
export type PropertyMediaVariantName = "THUMBNAIL" | "CARD" | "DETAIL";

export const PROPERTY_MEDIA_VARIANT_NAMES: readonly PropertyMediaVariantName[] = [
  "THUMBNAIL",
  "CARD",
  "DETAIL",
];

/**
 * `objectKey` is carried here for internal use (variant delete, this task) but — same rule as
 * `PropertyMedia.objectKey` — is never serialized into a public HTTP response; variants are not
 * exposed over HTTP at all yet (this task, section 96).
 */
export interface PropertyMediaVariant {
  id: string;
  propertyMediaId: string;
  variant: PropertyMediaVariantName;
  objectKey: string;
  publicUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
}

const VARIANT_OBJECT_KEY_FILENAMES: Record<PropertyMediaVariantName, string> = {
  THUMBNAIL: "thumbnail.webp",
  CARD: "card.webp",
  DETAIL: "detail.webp",
};

/**
 * Deterministic key so retries converge — a repeated `putObject()` for the same variant
 * overwrites the same object instead of creating a new one per attempt (ADR-008/ADR-009, this
 * task section 24/48). Built exclusively from technical ids + a fixed literal per variant —
 * never derived by slicing/transforming the original's own `object_key` (section 24), so it
 * never depends on that key's exact shape (including the pre-Prompt-030 flat
 * `.../<mediaId>.<ext>` format some originals still have).
 */
export function buildPropertyMediaVariantObjectKey(params: {
  tenantId: string;
  propertyId: string;
  mediaId: string;
  variant: PropertyMediaVariantName;
}): string {
  return `tenants/${params.tenantId}/properties/${params.propertyId}/${params.mediaId}/${VARIANT_OBJECT_KEY_FILENAMES[params.variant]}`;
}
