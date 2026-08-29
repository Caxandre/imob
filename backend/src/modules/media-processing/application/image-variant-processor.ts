import type { PropertyMediaVariantName } from "../../properties/domain/property-media-variant.js";

/**
 * One generated variant, in memory — never yet uploaded anywhere (this task, section 7). `body`
 * is the encoded WebP bytes; `width`/`height` are the *actual* output dimensions (after
 * `withoutEnlargement`/aspect-ratio-preserving resize), never the configured preset's target —
 * a source image smaller than the preset never gets enlarged, so this can legitimately be
 * smaller than the preset's max width.
 */
export interface ProcessedImageVariant {
  variant: PropertyMediaVariantName;
  body: Buffer;
  mimeType: "image/webp";
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Provider-agnostic port for turning one original image into its full set of derived variants
 * (Prompt 032, ADR-008) — domain/application code depends only on this interface, never on
 * `sharp` directly (this task, section 6/8); that stays confined entirely to
 * `sharp-image-variant-processor.ts`. Always produces every configured variant in one call, or
 * rejects with {@link UnsupportedPropertyMediaError} (from
 * `../domain/property-media-processing-error.js`) for a permanent condition — a partial result
 * (e.g. two variants generated, a third failed) is never returned.
 */
export interface ImageVariantProcessor {
  process(input: Buffer): Promise<ProcessedImageVariant[]>;
}
