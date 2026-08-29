import sharp from "sharp";

import type { PropertyMediaVariantName } from "../../properties/domain/property-media-variant.js";
import type { ImageVariantProcessor, ProcessedImageVariant } from "../application/image-variant-processor.js";
import { UnsupportedPropertyMediaError } from "../domain/property-media-processing-error.js";

/**
 * Preset target widths (ADR-008) — centralized here so no magic number is repeated elsewhere
 * (this task, section 9). Never a target height: every resize is width-only, letting `sharp`
 * derive height while preserving aspect ratio (section 11).
 */
export const PROPERTY_MEDIA_VARIANT_PRESETS: Record<PropertyMediaVariantName, { maxWidth: number }> = {
  THUMBNAIL: { maxWidth: 320 },
  CARD: { maxWidth: 640 },
  DETAIL: { maxWidth: 1280 },
};

/** ADR-008 "Variants" — a reasonable, widely-used default for photography, not micro-tuned. */
const WEBP_QUALITY = 82;

export interface SharpImageVariantProcessorOptions {
  /** Decompression-bomb guard (this task, section 14) — passed to every `sharp()` call so the
   * limit applies regardless of which specific decode step would otherwise trigger it. */
  maxInputPixels: number;
}

/**
 * Real, `sharp`-backed `ImageVariantProcessor` (Prompt 032, ADR-008). `sharp` is confined
 * entirely to this file — the port (`image-variant-processor.ts`) and every consumer
 * (`process-property-media-job.ts`) never import it (this task, section 6/8).
 *
 * Per variant: `.rotate()` with no argument bakes the EXIF auto-orientation into the pixel data
 * (section 12); never calling `.withMetadata()` means the WebP encode strips EXIF/ICC/XMP by
 * default — including GPS/camera/personal metadata (section 13) — without needing to enumerate
 * what to strip. `.resize({ width, withoutEnlargement: true })` preserves aspect ratio and never
 * upscales a source smaller than the preset (section 10/11) — no crop/stretch/cover/fill mode is
 * ever used. `.webp({ quality: 82 })` is the only output format (section 10); the original file
 * itself is never touched by this adapter.
 */
export function createSharpImageVariantProcessor(options: SharpImageVariantProcessorOptions): ImageVariantProcessor {
  return {
    async process(input: Buffer): Promise<ProcessedImageVariant[]> {
      let pages: number | undefined;
      try {
        const metadata = await sharp(input, { limitInputPixels: options.maxInputPixels }).metadata();
        pages = metadata.pages;
      } catch (error) {
        throw new UnsupportedPropertyMediaError("could not decode image", error);
      }

      // sharp reports pages/frames for TIFF/HEIF/PDF/animated GIF/animated WebP alike (this
      // task, section 15) — more than one means this is an animated/multi-page input, rejected
      // outright rather than silently processed as just its first frame.
      if (pages !== undefined && pages > 1) {
        throw new UnsupportedPropertyMediaError("animated or multi-page images are not supported");
      }

      const variants: ProcessedImageVariant[] = [];
      for (const [variant, preset] of Object.entries(PROPERTY_MEDIA_VARIANT_PRESETS) as [
        PropertyMediaVariantName,
        { maxWidth: number },
      ][]) {
        try {
          const { data, info } = await sharp(input, { limitInputPixels: options.maxInputPixels })
            .rotate()
            .resize({ width: preset.maxWidth, withoutEnlargement: true })
            .webp({ quality: WEBP_QUALITY })
            .toBuffer({ resolveWithObject: true });

          variants.push({
            variant,
            body: data,
            mimeType: "image/webp",
            width: info.width,
            height: info.height,
            sizeBytes: data.length,
          });
        } catch (error) {
          if (error instanceof UnsupportedPropertyMediaError) {
            throw error;
          }
          // Covers, among others, sharp's own pixel-limit rejection during actual decode —
          // `.metadata()` above reads the header only and may not trigger it (this task,
          // section 14): whichever step first hits the limit, it always surfaces here as the
          // same permanent classification.
          throw new UnsupportedPropertyMediaError(`failed to generate ${variant} variant`, error);
        }
      }

      return variants;
    },
  };
}
