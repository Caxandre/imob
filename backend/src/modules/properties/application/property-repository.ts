import type { Property, PropertyStatus, PropertyType, TransactionType } from "../domain/property.js";

export interface CreatePropertyInput {
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
}

export interface ListPropertiesInput {
  page: number;
  limit: number;
}

export interface ListPropertiesResult {
  data: Property[];
  total: number;
}

/**
 * Partial update — PATCH semantics (Prompt 022, sections 43/44): a key **absent** from this
 * object means "leave that column unchanged"; a key **present** with `null` (only on fields
 * whose domain type allows it) means "clear it". This is why every property here is optional
 * rather than this being `Partial<CreatePropertyInput>` with nullable fields collapsed —
 * `undefined` and `null` carry different meaning and must never be conflated. `id`,
 * `createdAt`, `updatedAt` are deliberately not present here: immutable via this input, ever.
 */
export interface UpdatePropertyInput {
  title?: string;
  description?: string | null;
  propertyType?: PropertyType;
  transactionType?: TransactionType;
  status?: PropertyStatus;
  price?: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  parkingSpaces?: number | null;
  areaM2?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}

/**
 * Persistence port for the Properties module. Always operates against a single tenant's own
 * database — an already-scoped `db` handle (see `drizzle-property-repository.ts`), never a
 * `tenantId` parameter. The repository never resolves a tenant itself (this task, section 19):
 * that is the HTTP layer's job, via `TenantDatabaseResolver`/`TenantDatabaseConnectionManager`,
 * before a repository instance is even constructed for a given request.
 */
export interface PropertyRepository {
  create(input: CreatePropertyInput): Promise<Property>;
  list(input: ListPropertiesInput): Promise<ListPropertiesResult>;
  findById(id: string): Promise<Property | undefined>;
  /** Returns `undefined` when no property with that id exists — never throws for "not found". */
  update(id: string, input: UpdatePropertyInput): Promise<Property | undefined>;
  /**
   * Sets `status = INACTIVE` (archival, never a physical `DELETE FROM properties` — CLAUDE.md/
   * ADR: domain records are not physically deleted by default). Idempotent: archiving an
   * already-`INACTIVE` property still succeeds and returns it, never an error. Returns
   * `undefined` when no property with that id exists.
   */
  archive(id: string): Promise<Property | undefined>;
}
