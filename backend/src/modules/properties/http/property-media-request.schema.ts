/** 10 MB per file (this task, section 24) — enforced by the multipart parser itself
 * (`limits.fileSize`, `property-routes.ts`), never only after fully buffering the upload
 * (section 25). */
export const MAX_MEDIA_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const MAX_ORIGINAL_FILENAME_LENGTH = 255;

/**
 * Reduces a client-supplied multipart filename to a safe basename (this task, sections 11/60)
 * — strips any directory components from either `/`- or `\`-style paths (so
 * `"../../foto.jpg"`/`"C:\\Users\\...\\foto.jpg"` both become `"foto.jpg"`), trims whitespace,
 * and caps length. Purely descriptive metadata — never used to build the object key (section
 * 33; see `buildPropertyMediaObjectKey` in `upload-property-media.ts`, which never even
 * receives this value). Returns `null` when nothing meaningful remains (filename absent, or
 * empty/all-whitespace/all-separators after stripping) — `property_media.original_filename` is
 * nullable specifically so this case is never coerced into a misleading empty string.
 */
export function sanitizeOriginalFilename(filename: string | undefined): string | null {
  if (filename === undefined) {
    return null;
  }

  const basename = filename.replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  if (basename.length === 0) {
    return null;
  }

  return basename.slice(0, MAX_ORIGINAL_FILENAME_LENGTH);
}
