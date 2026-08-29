import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { UnsupportedPropertyMediaError } from "../domain/property-media-processing-error.js";
import { createSharpImageVariantProcessor, PROPERTY_MEDIA_VARIANT_PRESETS } from "./sharp-image-variant-processor.js";

const DEFAULT_MAX_INPUT_PIXELS = 40_000_000;

async function buildTestImage(
  width: number,
  height: number,
  format: "jpeg" | "png" | "webp" = "jpeg",
): Promise<Buffer> {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  });
  if (format === "jpeg") return image.jpeg().toBuffer();
  if (format === "png") return image.png().toBuffer();
  return image.webp().toBuffer();
}

describe("createSharpImageVariantProcessor", () => {
  it.each(["jpeg", "png", "webp"] as const)(
    "generates exactly THUMBNAIL/CARD/DETAIL, all image/webp, from a real %s input",
    async (format) => {
      const processor = createSharpImageVariantProcessor({ maxInputPixels: DEFAULT_MAX_INPUT_PIXELS });
      const input = await buildTestImage(2000, 1500, format);

      const variants = await processor.process(input);

      expect(variants.map((v) => v.variant).sort()).toEqual(["CARD", "DETAIL", "THUMBNAIL"]);
      for (const variant of variants) {
        expect(variant.mimeType).toBe("image/webp");
        expect(variant.body.length).toBeGreaterThan(0);
        expect(variant.sizeBytes).toBe(variant.body.length);
        // The original format itself is never altered — only the derived variants are WebP.
        const decoded = await sharp(variant.body).metadata();
        expect(decoded.format).toBe("webp");
      }
    },
  );

  it("resizes to each preset's max width, preserving aspect ratio, for a large source", async () => {
    const processor = createSharpImageVariantProcessor({ maxInputPixels: DEFAULT_MAX_INPUT_PIXELS });
    // 2:1 aspect ratio, well above every preset's max width.
    const input = await buildTestImage(2560, 1280);

    const variants = await processor.process(input);

    for (const [variantName, preset] of Object.entries(PROPERTY_MEDIA_VARIANT_PRESETS) as [
      keyof typeof PROPERTY_MEDIA_VARIANT_PRESETS,
      { maxWidth: number },
    ][]) {
      const variant = variants.find((v) => v.variant === variantName);
      expect(variant?.width).toBe(preset.maxWidth);
      // 2:1 source — height is always exactly half the width, aspect ratio preserved.
      expect(variant?.height).toBe(Math.round(preset.maxWidth / 2));
    }
  });

  it("never enlarges a source smaller than a preset's max width (withoutEnlargement)", async () => {
    const processor = createSharpImageVariantProcessor({ maxInputPixels: DEFAULT_MAX_INPUT_PIXELS });
    // Smaller than even THUMBNAIL's 320px max width.
    const input = await buildTestImage(200, 150);

    const variants = await processor.process(input);

    for (const variant of variants) {
      expect(variant.width).toBe(200);
      expect(variant.height).toBe(150);
    }
  });

  it("throws UnsupportedPropertyMediaError for an undecodable buffer", async () => {
    const processor = createSharpImageVariantProcessor({ maxInputPixels: DEFAULT_MAX_INPUT_PIXELS });

    await expect(processor.process(Buffer.from("this is not an image"))).rejects.toBeInstanceOf(
      UnsupportedPropertyMediaError,
    );
  });

  it("throws UnsupportedPropertyMediaError when the input exceeds the configured pixel limit", async () => {
    // 100x100 = 10,000 px, comfortably over a limit of 100.
    const processor = createSharpImageVariantProcessor({ maxInputPixels: 100 });
    const input = await buildTestImage(100, 100);

    await expect(processor.process(input)).rejects.toBeInstanceOf(UnsupportedPropertyMediaError);
  });

  it("strips EXIF/ICC metadata from every generated variant", async () => {
    const processor = createSharpImageVariantProcessor({ maxInputPixels: DEFAULT_MAX_INPUT_PIXELS });
    const sourceWithMetadata = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .withMetadata({ density: 300 })
      .jpeg()
      .toBuffer();
    // Sanity check the fixture actually carries metadata worth stripping before asserting the
    // processor removes it.
    const sourceMetadata = await sharp(sourceWithMetadata).metadata();
    expect(sourceMetadata.density).toBe(300);

    const variants = await processor.process(sourceWithMetadata);

    for (const variant of variants) {
      const outputMetadata = await sharp(variant.body).metadata();
      expect(outputMetadata.exif).toBeUndefined();
      expect(outputMetadata.icc).toBeUndefined();
    }
  });

  it("applies EXIF auto-orientation instead of leaving the image visually rotated", async () => {
    const processor = createSharpImageVariantProcessor({ maxInputPixels: DEFAULT_MAX_INPUT_PIXELS });
    // A distinctly non-square source (200 wide x 100 tall) with EXIF orientation 6 (rotate 90°
    // CW) set on it — sharp's own documented way to construct a fixture whose *visual*
    // orientation differs from its raw pixel grid, without needing an external binary fixture.
    const rotatedSource = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 0, g: 200, b: 0 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const sourceMetadata = await sharp(rotatedSource).metadata();
    expect(sourceMetadata.orientation).toBe(6);

    const variants = await processor.process(rotatedSource);

    // Orientation 6 is a 90° rotation — the visually-correct output swaps width/height
    // relative to the raw pixel grid (200x100 raw → 100x200 visually-correct), proving
    // `.rotate()` baked the orientation into the pixels rather than leaving it as metadata
    // (which was already asserted stripped in the test above).
    const thumbnail = variants.find((v) => v.variant === "THUMBNAIL");
    expect(thumbnail?.width).toBeLessThan(thumbnail?.height ?? 0);
  });

  // Animated/multi-page rejection (`metadata.pages > 1`, this task section 15/75) is not
  // independently fixture-tested here: constructing a genuinely animated WebP/multi-page TIFF
  // in-process (real, distinct frames — not just a single-frame file with a misleading name)
  // is not practical without carrying an external binary asset this project has no other
  // reason to hold. The rejection is a single, directly-readable condition in
  // `sharp-image-variant-processor.ts` (`if (pages !== undefined && pages > 1) throw ...`),
  // reading the exact same `sharp().metadata().pages` field every static image processed in
  // the tests above already exercises as `undefined`/`1` (implicitly proving the non-animated
  // path is correctly the common case) — verified by code review per this task's own allowance
  // (section 75) rather than a synthetic multi-frame fixture.

  it("every generated variant reports a positive sizeBytes matching its actual body length", async () => {
    const processor = createSharpImageVariantProcessor({ maxInputPixels: DEFAULT_MAX_INPUT_PIXELS });
    const input = await buildTestImage(500, 500);

    const variants = await processor.process(input);

    expect(variants).toHaveLength(3);
    for (const variant of variants) {
      expect(variant.sizeBytes).toBeGreaterThan(0);
      expect(variant.sizeBytes).toBe(variant.body.length);
    }
  });
});
