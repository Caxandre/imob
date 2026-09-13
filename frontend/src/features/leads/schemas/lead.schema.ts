import { z } from "zod";

import { propertyStatusSchema } from "@/features/properties/schemas/property.schema";

/**
 * Response shapes verified directly against the backend source (Prompt 044, section 2/91-93)
 * rather than written from the prompt: `backend/src/modules/leads/http/lead-routes.ts`
 * (`toLeadResponse`/`toLeadWithPropertyResponse`) and `lead-openapi.schema.ts`. All field names
 * are snake_case.
 */

export const leadStatusSchema = z.enum(["NEW", "CONTACTED", "QUALIFIED", "WON", "LOST"]);
export type LeadStatus = z.infer<typeof leadStatusSchema>;

export const leadSourceSchema = z.enum(["MANUAL", "WEBSITE", "WHATSAPP", "PORTAL", "OTHER"]);
export type LeadSource = z.infer<typeof leadSourceSchema>;

// Reuses Properties' own status enum (the summary embeds a real Property status value, never a
// separately invented one) — `id`/`title`/`status` is exactly and only what
// `toLeadWithPropertyResponse` serializes, never the full Property (section 32).
export const leadPropertySummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: propertyStatusSchema,
});
export type LeadPropertySummary = z.infer<typeof leadPropertySummarySchema>;

// Shared by both response shapes below — `POST`/`PATCH` responses (`toLeadResponse`) never
// carry `property` at all, while `GET` list items/detail (`toLeadWithPropertyResponse`) add it
// on top of these exact same fields (section 66/67 — verified directly against
// `lead-routes.ts`, never assumed).
const leadFieldsSchema = z.object({
  id: z.string(),
  property_id: z.string().nullable(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: leadStatusSchema,
  source: leadSourceSchema,
  message: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// `POST /api/v1/leads` and `PATCH /api/v1/leads/:id` response shape — never `property`.
export const leadSchema = leadFieldsSchema;
export type Lead = z.infer<typeof leadSchema>;

// `GET /api/v1/leads` (each item) and `GET /api/v1/leads/:id` response shape.
export const leadWithPropertySchema = leadFieldsSchema.extend({
  property: leadPropertySummarySchema.nullable(),
});
export type LeadWithProperty = z.infer<typeof leadWithPropertySchema>;

export const leadListResponseSchema = z.object({
  data: z.array(leadWithPropertySchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    total_pages: z.number(),
  }),
});
export type LeadListResponse = z.infer<typeof leadListResponseSchema>;
export type LeadPagination = LeadListResponse["pagination"];
