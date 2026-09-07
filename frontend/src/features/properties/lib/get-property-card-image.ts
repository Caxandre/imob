import type { Property } from "../schemas/property.schema";

/**
 * Card image selection (Prompt 037B, sections 18-19): priority is CARD variant → THUMBNAIL
 * variant → the media's own original `public_url` → no image at all. Never conditioned on
 * `processing_status` — a `PROCESSING`/`FAILED`/legacy media can still have a usable variant or
 * original URL, so we simply take the first URL that actually exists.
 */
export function getPropertyCardImage(property: Property): string | null {
  const cover = property.cover;

  if (!cover) {
    return null;
  }

  return cover.variants.card?.url ?? cover.variants.thumbnail?.url ?? cover.public_url ?? null;
}
