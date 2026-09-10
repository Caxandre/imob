import { z } from "zod";

const propertyIdSchema = z.uuid();

/**
 * Validates the `:id` route param before it is ever used in a request (Prompt 038, section 7)
 * — an obviously-invalid id (e.g. `/properties/abc`) must render a not-found state without
 * making any network call.
 */
export function isValidPropertyId(id: string | undefined): id is string {
  return id !== undefined && propertyIdSchema.safeParse(id).success;
}
