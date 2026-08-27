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
}
