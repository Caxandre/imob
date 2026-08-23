import type { Tenant } from "../domain/tenant.js";

export interface CreateTenantInput {
  name: string;
  slug: string;
}

/**
 * Persistence port for this use case. Intentionally narrow: only what creating a tenant
 * needs, no generic CRUD.
 *
 * `createWithProvisioningIntent` must persist the tenant together with the intent to
 * provision its database (a PENDING `provisioning_jobs` row) as a single atomic operation:
 * a tenant never exists in this system without that intent recorded alongside it. How that
 * atomicity is achieved (e.g. a database transaction) is an infrastructure concern this
 * interface deliberately does not expose.
 */
export interface TenantRepository {
  /** Throws {@link TenantSlugAlreadyExistsError} when the slug is taken. */
  createWithProvisioningIntent(input: CreateTenantInput): Promise<Tenant>;
}

/**
 * Creates a tenant in the Control Plane, atomically persisting the intent to provision its
 * database. The tenant is persisted with the database default status (PROVISIONING); no
 * database provisioning is actually started here.
 */
export async function createTenant(
  repository: TenantRepository,
  input: CreateTenantInput,
): Promise<Tenant> {
  return repository.createWithProvisioningIntent(input);
}
