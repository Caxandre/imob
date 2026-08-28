import { describe, expect, it } from "vitest";

import { matchesDeclaredMimeType } from "./property-media-file-signature.js";

const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP_HEADER = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
]);
const PLAIN_TEXT = Buffer.from("hello-r2", "ascii");

describe("matchesDeclaredMimeType", () => {
  it("accepts a real JPEG signature for image/jpeg", () => {
    expect(matchesDeclaredMimeType("image/jpeg", JPEG_HEADER)).toBe(true);
  });

  it("accepts a real PNG signature for image/png", () => {
    expect(matchesDeclaredMimeType("image/png", PNG_HEADER)).toBe(true);
  });

  it("accepts a real WebP (RIFF....WEBP) signature for image/webp", () => {
    expect(matchesDeclaredMimeType("image/webp", WEBP_HEADER)).toBe(true);
  });

  it("rejects plain text content declared as any of the three image types", () => {
    expect(matchesDeclaredMimeType("image/jpeg", PLAIN_TEXT)).toBe(false);
    expect(matchesDeclaredMimeType("image/png", PLAIN_TEXT)).toBe(false);
    expect(matchesDeclaredMimeType("image/webp", PLAIN_TEXT)).toBe(false);
  });

  it("rejects a PNG signature declared as image/jpeg (cross-format mismatch)", () => {
    expect(matchesDeclaredMimeType("image/jpeg", PNG_HEADER)).toBe(false);
  });

  it("rejects a JPEG signature declared as image/webp (cross-format mismatch)", () => {
    expect(matchesDeclaredMimeType("image/webp", JPEG_HEADER)).toBe(false);
  });

  it("rejects an empty buffer for every type", () => {
    const empty = Buffer.alloc(0);
    expect(matchesDeclaredMimeType("image/jpeg", empty)).toBe(false);
    expect(matchesDeclaredMimeType("image/png", empty)).toBe(false);
    expect(matchesDeclaredMimeType("image/webp", empty)).toBe(false);
  });

  it("rejects a buffer too short to contain the full signature", () => {
    expect(matchesDeclaredMimeType("image/png", PNG_HEADER.subarray(0, 4))).toBe(false);
    expect(matchesDeclaredMimeType("image/webp", WEBP_HEADER.subarray(0, 6))).toBe(false);
  });
});
