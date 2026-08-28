import type { PropertyMediaMimeType } from "../domain/property-media.js";

/**
 * Minimal, dependency-free magic-byte checks (this task, section 29) — a client-declared MIME
 * type (from the multipart `Content-Type` header of that part) is never trusted alone (section
 * 27/28: never infer safety from a filename/extension either). All three formats this module
 * accepts have simple, well-documented, fixed-position signatures, so no image-parsing library
 * is needed just to confirm "this really looks like a JPEG/PNG/WebP" — a full decode is exactly
 * the kind of heavier dependency this task's section 29 says to avoid without real need.
 */

function matchesJpegSignature(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function matchesPngSignature(buffer: Buffer): boolean {
  return buffer.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => buffer[index] === byte);
}

// RIFF container: bytes 0-3 "RIFF", bytes 4-7 chunk size (ignored here), bytes 8-11 "WEBP".
function matchesWebpSignature(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

/**
 * Confirms `buffer`'s content actually matches its declared `mimeType`, independent of anything
 * the client claimed in headers/filename. Never throws — callers decide how to map "false" to
 * an HTTP response (this task's `property-media-routes.ts` maps it to `400`, never leaking which
 * byte failed).
 */
export function matchesDeclaredMimeType(mimeType: PropertyMediaMimeType, buffer: Buffer): boolean {
  switch (mimeType) {
    case "image/jpeg":
      return matchesJpegSignature(buffer);
    case "image/png":
      return matchesPngSignature(buffer);
    case "image/webp":
      return matchesWebpSignature(buffer);
  }
}
