/**
 * Raised by an `ImageVariantProcessor` (or by `processPropertyMediaJob` for a confirmed-missing
 * original) for a *permanent*, provider-agnostic classification of "this original can never be
 * processed" (Prompt 032, section 16) — never for a transient condition. Cases: a corrupted/
 * undecodable file, dimensions/pixel count above the configured limit (decompression-bomb
 * guard), or an animated/multi-page image (not supported yet). Never named after `sharp`
 * specifically — the application layer (`process-property-media-job.ts`) only ever imports this
 * class, never `sharp` itself (this task, section 6).
 */
export class UnsupportedPropertyMediaError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(`Unsupported property media: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = "UnsupportedPropertyMediaError";
  }
}
