/**
 * Client-side mirror of the backend's own upload constraints (Prompt 041, section 16/18) — for
 * UX only (instant feedback before a network call), never the source of truth: the backend
 * (`property-media-request.schema.ts`/`property-media.ts`) validates MIME by magic bytes and
 * size via the multipart parser regardless of what the client claims (section 17).
 */
export const ALLOWED_PROPERTY_MEDIA_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

// Mirrors `MAX_MEDIA_FILE_SIZE_BYTES` in
// `backend/src/modules/properties/http/property-media-request.schema.ts` (10 MB).
export const MAX_PROPERTY_MEDIA_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export type PropertyMediaFileValidationError = "unsupported-type" | "too-large";

/** Returns `null` when the file passes the client-side checks, or the failure reason otherwise. */
export function validatePropertyMediaFile(file: File): PropertyMediaFileValidationError | null {
  if (!(ALLOWED_PROPERTY_MEDIA_MIME_TYPES as readonly string[]).includes(file.type)) {
    return "unsupported-type";
  }

  if (file.size > MAX_PROPERTY_MEDIA_FILE_SIZE_BYTES) {
    return "too-large";
  }

  return null;
}

export function describePropertyMediaFileValidationError(
  error: PropertyMediaFileValidationError,
): string {
  switch (error) {
    case "unsupported-type":
      return "Formato não suportado — use JPEG, PNG ou WebP.";
    case "too-large":
      return "Arquivo maior que 10 MB.";
  }
}
