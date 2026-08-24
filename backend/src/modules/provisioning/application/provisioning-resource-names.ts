import { z } from "zod";

/**
 * Raised when a caller passes something other than a real UUID as tenantId. Resource
 * identity must never silently fall back to another shape (slug, name, timestamp,
 * random) — an invalid tenantId is a programming error and must fail loudly.
 */
export class InvalidTenantIdError extends Error {
  constructor(tenantId: string) {
    super(`Invalid tenantId: expected a UUID, received "${tenantId}"`);
    this.name = "InvalidTenantIdError";
  }
}

export interface ProvisioningResourceNames {
  databaseName: string;
  roleName: string;
  secretReference: string;
}

const tenantIdSchema = z.uuid();

/**
 * Derives the deterministic resource names ADR-003 assigns to a tenant's infrastructure,
 * from tenantId alone. Same tenantId always yields the same names; two different tenants
 * never collide. Never derived from tenant.slug/name, timestamps, or randomness.
 */
export function buildProvisioningResourceNames(tenantId: string): ProvisioningResourceNames {
  const result = tenantIdSchema.safeParse(tenantId);
  if (!result.success) {
    throw new InvalidTenantIdError(tenantId);
  }

  const canonical = result.data.toLowerCase();
  const compact = canonical.replaceAll("-", "");

  return {
    databaseName: `tenant_${compact}`,
    roleName: `tenant_${compact}_app`,
    secretReference: `tenant-databases/${canonical}`,
  };
}
