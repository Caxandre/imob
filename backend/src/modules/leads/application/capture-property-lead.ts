import type { PropertyRepository } from "../../properties/application/property-repository.js";
import { PublicPropertyNotFoundError, type Lead } from "../domain/lead.js";
import type { CreateLeadInput, LeadRepository } from "./lead-repository.js";

/**
 * Public-facing input (Prompt 045, sections 6-11) — deliberately narrower than
 * `CreateLeadInput`: no `status`/`source`/`notes`/`propertyId`. Those are either forced by this
 * use case itself (`status: NEW` via the repository default, `source: "WEBSITE"`, `notes:
 * null`) or supplied out of band — the property id comes from the route, never the body
 * (section 12), so it is a separate parameter below rather than a field on this type.
 */
export interface CapturePropertyLeadInput {
  name: string;
  email: string | null;
  phone: string | null;
  message: string | null;
}

/**
 * Creates a lead from an unauthenticated visitor expressing interest in a specific, published
 * property (Prompt 045) — the public counterpart to `createLead()`, but deliberately not built
 * on top of it (section 20: a public handler must never call into the administrative one). The
 * two use cases enforce genuinely different property rules — optional and any status for the
 * admin flow (`create-lead.ts`), mandatory and `ACTIVE`-only here (sections 13/15) — so
 * reusing `createLead()`'s call shape would only obscure that difference. Both still share the
 * same `LeadRepository`/`PropertyRepository` ports — no second repository, no ad hoc SQL
 * (sections 21/22).
 *
 * The property lookup and the lead insert are two separate statements, not wrapped in one
 * transaction (section 23): a property could theoretically be archived in the instant between
 * the two, but a lead created from that narrow race is still legitimate commercial signal (the
 * visitor saw an available property and acted on it) — not a correctness bug worth a `SELECT
 * ... FOR UPDATE` for. This read-then-create consistency is a deliberate choice, not an
 * oversight — see ARCHITECTURE.md.
 */
export async function capturePropertyLead(
  leadRepository: LeadRepository,
  propertyRepository: PropertyRepository,
  propertyId: string,
  input: CapturePropertyLeadInput,
): Promise<Lead> {
  const property = await propertyRepository.findById(propertyId);
  if (!property || property.status !== "ACTIVE") {
    throw new PublicPropertyNotFoundError(propertyId);
  }

  const createInput: CreateLeadInput = {
    propertyId,
    name: input.name,
    email: input.email,
    phone: input.phone,
    source: "WEBSITE",
    message: input.message,
    notes: null,
  };

  return leadRepository.create(createInput);
}
