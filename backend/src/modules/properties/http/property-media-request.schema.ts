import { z } from "zod";

import { UUID_PATTERN } from "./property-request.schema.js";

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

/** `{ id, mediaId }` route params, shared by the cover and delete routes (Prompt 028) — reuses
 * `propertyIdParamsSchema`'s own `UUID_PATTERN` so both id checks stay identical. */
export const propertyMediaIdParamsSchema = z.object({
  id: z.string().trim().regex(UUID_PATTERN, "id must be a valid UUID"),
  mediaId: z.string().trim().regex(UUID_PATTERN, "mediaId must be a valid UUID"),
});

export type PropertyMediaIdParams = z.infer<typeof propertyMediaIdParamsSchema>;

/**
 * `PUT /api/v1/properties/:id/media/order` body (Prompt 028, section 67). `.strict()` rejects
 * any key besides `media_ids` (e.g. an accidental `object_key`/`position`/`is_cover` — this
 * task, section 80: those are always server-controlled, never client input). Duplicate ids are
 * rejected here (section 19) — a structural/shape concern, decided before the request ever
 * reaches the repository, which only ever sees an already-deduplicated array. Deliberately no
 * `.max()` on the array (section 68 — no gallery size limit invented for this task) and no
 * `.min()` either — an empty array is a legitimate submission (the no-op case for a property
 * with no media, section 20), rejected or accepted based on the *current* gallery state, which
 * only the repository (inside its transaction) can know.
 */
export const reorderPropertyMediaBodySchema = z
  .object({
    media_ids: z.array(z.string().trim().regex(UUID_PATTERN, "each media id must be a valid UUID")),
  })
  .strict()
  .refine((body) => new Set(body.media_ids).size === body.media_ids.length, {
    message: "media_ids must not contain duplicates",
    path: ["media_ids"],
  });

export type ReorderPropertyMediaBody = z.infer<typeof reorderPropertyMediaBodySchema>;
