import type { PropertyStatus } from "../../properties/domain/property.js";
import type { Lead } from "./lead.js";

/**
 * Minimal read-model projection of the property a lead references (Prompt 043, section 42) —
 * deliberately not the full `Property`: no description, no media, no full address, no
 * variants. Loaded via a single `LEFT JOIN` in `drizzle-lead-repository.ts` (`list`/
 * `findById`), never a per-lead follow-up query (section 44) — `id`/`title`/`status` are
 * exactly the columns that JOIN selects.
 */
export interface LeadPropertySummary {
  id: string;
  title: string;
  status: PropertyStatus;
}

/**
 * `Lead` plus its optionally-resolved property summary (Prompt 043, sections 42/43/46) — what
 * `GET /api/v1/leads` and `GET /api/v1/leads/:id` return. `property` is `null` exactly when
 * `propertyId` is `null` (a generic lead) — `create`/`update` never carry this extra field
 * (they return a plain `Lead`), same asymmetry `PropertyWithCover` already established for
 * Properties' own `cover` (list/detail-only, never on create/patch responses).
 */
export interface LeadWithPropertySummary extends Lead {
  property: LeadPropertySummary | null;
}
