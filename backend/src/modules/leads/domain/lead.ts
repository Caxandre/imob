export type LeadStatus = "NEW" | "CONTACTED" | "QUALIFIED" | "WON" | "LOST";

export type LeadSource = "MANUAL" | "WEBSITE" | "WHATSAPP" | "PORTAL" | "OTHER";

/**
 * Lead as the application layer sees it — kept free of Drizzle/PostgreSQL types, same
 * convention as `Property`. Deliberately has no `tenantId`: this is a Tenant Data Plane row,
 * and the physical database it lives in is already the tenant boundary (ADR-001). No
 * `assignedToUserId`/owner field yet — there is no authenticated user concept in this system
 * yet (only the temporary `X-Tenant-Id` HTTP mechanism), so lead assignment to a specific
 * broker is out of scope for this foundation (Prompt 043, section 3).
 *
 * `email`/`phone` are both nullable at the type level, but a `Lead` never actually has both
 * `null` at once in practice — that combination is rejected by the HTTP boundary
 * (`lead-request.schema.ts`), re-validated against the resulting state by the application layer
 * on partial update (`update-lead.ts`), and enforced as a last resort by a database CHECK
 * (`leads_contact_channel_required`, `infrastructure/database/tenant/schema.ts`).
 *
 * PII: `name`/`email`/`phone`/`message`/`notes` are personal data (Prompt 043, section 53) —
 * never log this object's full contents in routine application logs (only `id`/`status`/
 * `source` where useful, e.g. `lead-routes.ts`'s request-completed log lines).
 */
export interface Lead {
  id: string;
  propertyId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  status: LeadStatus;
  source: LeadSource;
  message: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Raised when no lead with the given id exists in the resolved tenant's database. */
export class LeadNotFoundError extends Error {
  readonly leadId: string;

  constructor(leadId: string) {
    super(`Lead "${leadId}" was not found`);
    this.name = "LeadNotFoundError";
    this.leadId = leadId;
  }
}

/**
 * Raised when a lead's `property_id` (on create or update) does not resolve to a property in
 * the *current* tenant's own database (Prompt 043, sections 27/64) — including a well-formed
 * UUID that belongs to a different tenant entirely, which is architecturally indistinguishable
 * from "does not exist" from inside this tenant's database. Maps to 404 (`lead-error-mapper.ts`)
 * — the property association is the thing not found, not the lead itself.
 */
export class LeadPropertyNotFoundError extends Error {
  readonly propertyId: string;

  constructor(propertyId: string) {
    super(`Property "${propertyId}" was not found`);
    this.name = "LeadPropertyNotFoundError";
    this.propertyId = propertyId;
  }
}

/**
 * Raised when an update would leave a lead with neither `email` nor `phone` (Prompt 043,
 * sections 14/48/49) — the invariant every lead must retain at least one contact channel.
 * Thrown by `update-lead.ts` after computing the *resulting* state (existing values merged with
 * the partial payload, never just the payload alone), and also by
 * `drizzle-lead-repository.ts` if the database CHECK itself is what catches a race between two
 * concurrent updates each clearing a different channel — either path ends up as a safe 400, never
 * a raw constraint-violation message or a generic 500 (`lead-error-mapper.ts`).
 */
export class LeadContactChannelRequiredError extends Error {
  readonly leadId?: string;

  constructor(leadId?: string) {
    super("A lead must have at least one contact channel: email or phone");
    this.name = "LeadContactChannelRequiredError";
    this.leadId = leadId;
  }
}
