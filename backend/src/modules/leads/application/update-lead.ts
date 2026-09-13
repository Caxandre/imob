import type { PropertyRepository } from "../../properties/application/property-repository.js";
import { LeadContactChannelRequiredError, LeadNotFoundError, LeadPropertyNotFoundError, type Lead } from "../domain/lead.js";
import type { LeadRepository, UpdateLeadInput } from "./lead-repository.js";

export type { UpdateLeadInput } from "./lead-repository.js";

/**
 * Partially updates a lead in the already-resolved tenant's database (Prompt 043, sections
 * 47-49). Two checks happen here, before any write:
 *
 * 1. If `propertyId` is present in `input` (whether a new id or `null`), a non-`null` value
 *    must resolve to a property in this same tenant database (same rule as `createLead`,
 *    section 27) — `null` always passes (clearing the association is always allowed).
 * 2. The invariant "at least one contact channel" is validated against the *resulting* state —
 *    existing `email`/`phone` merged with whatever `input` actually changes — never the partial
 *    payload alone (section 48/49). A PATCH `{ email: null }` against a lead whose `phone` is
 *    already `null` must fail even though `email` itself is a valid, well-formed field value;
 *    a PATCH `{ email: null }` against a lead that has a `phone` must succeed.
 *
 * This pre-check is the common-case path; the database CHECK
 * (`leads_contact_channel_required`) remains the last-resort barrier against a genuine race
 * between two concurrent updates each clearing a different channel — see
 * `drizzle-lead-repository.ts`.
 */
export async function updateLead(
  leadRepository: LeadRepository,
  propertyRepository: PropertyRepository,
  id: string,
  input: UpdateLeadInput,
): Promise<Lead> {
  const existing = await leadRepository.findById(id);
  if (!existing) {
    throw new LeadNotFoundError(id);
  }

  if ("propertyId" in input && input.propertyId !== null && input.propertyId !== undefined) {
    const property = await propertyRepository.findById(input.propertyId);
    if (!property) {
      throw new LeadPropertyNotFoundError(input.propertyId);
    }
  }

  const resultingEmail = "email" in input ? input.email : existing.email;
  const resultingPhone = "phone" in input ? input.phone : existing.phone;
  if (resultingEmail === null && resultingPhone === null) {
    throw new LeadContactChannelRequiredError(id);
  }

  const updated = await leadRepository.update(id, input);
  if (!updated) {
    throw new LeadNotFoundError(id);
  }

  return updated;
}
