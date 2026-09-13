import { z } from "zod";

const leadIdSchema = z.uuid();

/**
 * Validates the `:id` route param before it is ever used in a request (Prompt 044, section 29)
 * — an obviously-invalid id must render a not-found state without making any network call.
 */
export function isValidLeadId(id: string | undefined): id is string {
  return id !== undefined && leadIdSchema.safeParse(id).success;
}
