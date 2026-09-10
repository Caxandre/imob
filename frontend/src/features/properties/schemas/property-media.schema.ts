import { z } from "zod";

import { mediaProcessingStatusSchema, propertyMediaVariantSchema } from "./property.schema";

/**
 * `GET /api/v1/properties/:id/media` response (Prompt 038, section 16), verified directly
 * against `backend/src/modules/properties/http/property-routes.ts`
 * (`toPropertyMediaResponse`) and `property-openapi.schema.ts` (`propertyMediaSchema`) rather
 * than the prompt's own field list. `variants` always carries exactly `thumbnail`/`card`/
 * `detail` — unlike the catalog's cover projection, `detail` is present here because the detail
 * page (unlike the catalog) actually needs it (Prompt 037B, section 15 reasoning, inverted).
 */
export const propertyMediaSchema = z.object({
  id: z.string(),
  property_id: z.string(),
  public_url: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  original_filename: z.string().nullable(),
  position: z.number(),
  is_cover: z.boolean(),
  processing_status: mediaProcessingStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  variants: z.object({
    thumbnail: propertyMediaVariantSchema.nullable(),
    card: propertyMediaVariantSchema.nullable(),
    detail: propertyMediaVariantSchema.nullable(),
  }),
});
export type PropertyMedia = z.infer<typeof propertyMediaSchema>;

export const propertyMediaListResponseSchema = z.object({
  data: z.array(propertyMediaSchema),
});
export type PropertyMediaListResponse = z.infer<typeof propertyMediaListResponseSchema>;
