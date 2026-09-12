import { LeadNotFoundError } from "../domain/lead.js";
import type { LeadWithPropertySummary } from "../domain/lead-property-summary.js";
import type { LeadRepository } from "./lead-repository.js";

/**
 * Fetches a single lead — with its resolved property summary (Prompt 043, section 46) — from
 * the already-resolved tenant's database. Throws {@link LeadNotFoundError} when absent.
 */
export async function getLead(repository: LeadRepository, id: string): Promise<LeadWithPropertySummary> {
  const lead = await repository.findById(id);

  if (!lead) {
    throw new LeadNotFoundError(id);
  }

  return lead;
}
