export type PropertyType = "HOUSE" | "APARTMENT" | "LAND" | "COMMERCIAL" | "OTHER";

export type TransactionType = "SALE" | "RENT";

export type PropertyStatus = "DRAFT" | "ACTIVE" | "INACTIVE";

/**
 * Property as the application layer sees it — kept free of Drizzle/PostgreSQL types, same
 * convention as `Tenant` (`src/modules/tenants/domain/tenant.ts`). Deliberately has no
 * `tenantId`: this is a Tenant Data Plane row, and the physical database it lives in is
 * already the tenant boundary (ADR-001) — carrying a `tenantId` field here would invite
 * exactly the kind of cross-tenant filter bug database-per-tenant exists to make impossible.
 * `price`/`areaM2` are decimal strings, never `number` — see `create-property.schema.ts` for
 * why (JavaScript's `number` cannot round-trip arbitrary-precision decimals safely).
 */
export interface Property {
  id: string;
  title: string;
  description: string | null;
  propertyType: PropertyType;
  transactionType: TransactionType;
  status: PropertyStatus;
  price: string;
  bedrooms: number | null;
  bathrooms: number | null;
  parkingSpaces: number | null;
  areaM2: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Raised when no property with the given id exists in the resolved tenant's database. */
export class PropertyNotFoundError extends Error {
  readonly propertyId: string;

  constructor(propertyId: string) {
    super(`Property "${propertyId}" was not found`);
    this.name = "PropertyNotFoundError";
    this.propertyId = propertyId;
  }
}

/**
 * Raised when an action is attempted against an `INACTIVE` (archived) property that only
 * `DRAFT`/`ACTIVE` properties may accept (Prompt 027, section 42) — currently just media
 * upload. Maps to `409 Conflict` (`property-error-mapper.ts`), the same status already used for
 * "tenant not ready" elsewhere in this module: the request cannot be completed given the
 * resource's current state, not something a corrected request body would fix.
 */
export class PropertyArchivedError extends Error {
  readonly propertyId: string;

  constructor(propertyId: string) {
    super(`Property "${propertyId}" is archived (INACTIVE) and cannot accept this action`);
    this.name = "PropertyArchivedError";
    this.propertyId = propertyId;
  }
}
