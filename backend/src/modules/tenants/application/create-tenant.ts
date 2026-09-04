import type { Tenant } from "../domain/tenant.js";
import type { CreateTenantInput, TenantRepository } from "./tenant-repository.js";

export type { CreateTenantInput, TenantRepository };

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
