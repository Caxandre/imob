import type { PropertyMedia } from "../schemas/property-media.schema";

/**
 * Main image for the detail page (Prompt 038, section 19): DETAIL variant → CARD → THUMBNAIL →
 * the original `public_url`. `public_url` is a required field on every media row, so this never
 * actually falls through to nothing for a real media item — the "no image" case only exists at
 * the gallery level, when there is no media at all (section 26).
 */
export function getPropertyDetailImageUrl(media: PropertyMedia): string {
  return (
    media.variants.detail?.url ??
    media.variants.card?.url ??
    media.variants.thumbnail?.url ??
    media.public_url
  );
}

/**
 * Thumbnail strip image (Prompt 038, section 20) — deliberately never DETAIL: THUMBNAIL → CARD
 * → the original `public_url`.
 */
export function getPropertyThumbnailImageUrl(media: PropertyMedia): string {
  return media.variants.thumbnail?.url ?? media.variants.card?.url ?? media.public_url;
}
