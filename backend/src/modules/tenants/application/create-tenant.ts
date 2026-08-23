import type { Tenant } from "../domain/tenant.js";

export interface CreateTenantInput {
  name: string;
  slug: string;
}

/**
 * Persistence port for this use case. Intentionally narrow: only what creating a tenant
 * needs, no generic CRUD.
 */
export interface TenantRepository {
  /** Throws {@link TenantSlugAlreadyExistsError} when the slug is taken. */
  create(input: CreateTenantInput): Promise<Tenant>;
}

/**
 * Creates a tenant in the Control Plane. The tenant is persisted with the database default
 * status (PROVISIONING); no database provisioning is started here.
 */
export async function createTenant(
  repository: TenantRepository,
  input: CreateTenantInput,
): Promise<Tenant> {
  return repository.create(input);
}
