import type { PropertyRepository } from "../../properties/application/property-repository.js";
import { LeadPropertyNotFoundError, type Lead } from "../domain/lead.js";
import type { CreateLeadInput, LeadRepository } from "./lead-repository.js";

export type { CreateLeadInput } from "./lead-repository.js";

/**
 * Creates a lead in the already-resolved tenant's database (Prompt 043, section 25). When
 * `propertyId` is present, it must resolve to a property in this *same* tenant database
 * (section 27/64) — checked explicitly here via `propertyRepository.findById`, never inferred
 * from the foreign key alone: a clean, predictable 404 is preferable to surfacing a raw FK
 * violation. No restriction on the referenced property's `status` (section 28) — an `INACTIVE`
 * property is a perfectly valid lead association; commercial lifecycle and listing availability
 * are distinct concepts.
 */
export async function createLead(
  leadRepository: LeadRepository,
  propertyRepository: PropertyRepository,
  input: CreateLeadInput,
): Promise<Lead> {
  if (input.propertyId !== null) {
    const property = await propertyRepository.findById(input.propertyId);
    if (!property) {
      throw new LeadPropertyNotFoundError(input.propertyId);
    }
  }

  return leadRepository.create(input);
}
