import { z } from "zod";

/**
 * Response shapes for `GET /api/v1/properties`, verified directly against the backend source
 * (Prompt 037B, section 3) rather than written from the prompt or from memory:
 * `backend/src/modules/properties/http/property-routes.ts` (`toPropertyListItemResponse`,
 * `toPropertyCoverResponse`, `toVariantResponse`) and `property-openapi.schema.ts`
 * (`propertyListItemSchema`, `propertyListSchema`). All field names are snake_case.
 */

export const propertyStatusSchema = z.enum(["DRAFT", "ACTIVE", "INACTIVE"]);
export type PropertyStatus = z.infer<typeof propertyStatusSchema>;

export const propertyTypeSchema = z.enum(["HOUSE", "APARTMENT", "LAND", "COMMERCIAL", "OTHER"]);
export type PropertyType = z.infer<typeof propertyTypeSchema>;

export const transactionTypeSchema = z.enum(["SALE", "RENT"]);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

export const mediaProcessingStatusSchema = z.enum(["PROCESSING", "READY", "FAILED"]);
export type MediaProcessingStatus = z.infer<typeof mediaProcessingStatusSchema>;

// Never `object_key`/bucket/storage internals (section 17) — only what the backend's
// `toVariantResponse` actually serializes.
export const propertyMediaVariantSchema = z.object({
  url: z.string(),
  mime_type: z.string(),
  width: z.number(),
  height: z.number(),
  size_bytes: z.number(),
});
export type PropertyMediaVariant = z.infer<typeof propertyMediaVariantSchema>;

// Deliberately no `detail` variant (section 15) — the listing projection never returns one.
export const propertyCoverSchema = z.object({
  id: z.string(),
  public_url: z.string(),
  processing_status: mediaProcessingStatusSchema,
  variants: z.object({
    thumbnail: propertyMediaVariantSchema.nullable(),
    card: propertyMediaVariantSchema.nullable(),
  }),
});
export type PropertyCover = z.infer<typeof propertyCoverSchema>;

// Shared with both response shapes below (Prompt 038, section 15): `GET /api/v1/properties/:id`
// (`toPropertyResponse`) never carries `cover` at all, while `GET /api/v1/properties` items
// (`toPropertyListItemResponse`) add it on top of these exact same fields — verified directly
// against `backend/src/modules/properties/http/property-routes.ts`. Defined once so the two
// response schemas below never duplicate this field list.
const propertyFieldsSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  property_type: propertyTypeSchema,
  transaction_type: transactionTypeSchema,
  status: propertyStatusSchema,
  // Decimal string, e.g. "450000.00" — never coerced to number here (section 27); formatting
  // helpers convert for display only.
  price: z.string(),
  bedrooms: z.number().nullable(),
  bathrooms: z.number().nullable(),
  parking_spaces: z.number().nullable(),
  // Field name is `area_m2`, not `area` (section 24 — never invent a field name).
  area_m2: z.string().nullable(),
  street: z.string().nullable(),
  number: z.string().nullable(),
  complement: z.string().nullable(),
  neighborhood: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postal_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const propertySchema = propertyFieldsSchema.extend({
  cover: propertyCoverSchema.nullable(),
});
export type Property = z.infer<typeof propertySchema>;

// `GET /api/v1/properties/:id` response (Prompt 038, section 3/15) — `toPropertyResponse`'s
// fields only, never `cover` (that projection exists solely on the list endpoint, section 23/24
// of Prompt 037B).
export const propertyDetailSchema = propertyFieldsSchema;
export type PropertyDetail = z.infer<typeof propertyDetailSchema>;

export const propertyListResponseSchema = z.object({
  data: z.array(propertySchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    total_pages: z.number(),
  }),
});
export type PropertyListResponse = z.infer<typeof propertyListResponseSchema>;
export type PropertyPagination = PropertyListResponse["pagination"];
