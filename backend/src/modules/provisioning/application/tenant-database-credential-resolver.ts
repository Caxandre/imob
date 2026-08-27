import type { TenantDatabaseCredential } from "./database-credential.js";
import { tenantDatabaseCredentialSchema } from "./database-credential.js";
import type { SecretStore } from "./secret-store.js";
import { InvalidTenantSecretError } from "./tenant-role-provisioner.js";

/**
 * Raised when `SecretStore.get()` finds nothing at the tenant's `secretReference`. Unlike
 * `TenantRoleProvisioner` (where a missing secret is one of four valid states it reconciles
 * by generating a fresh credential), this resolver is used *after* role provisioning is
 * expected to have already completed — a missing secret at this point is a genuine
 * inconsistency to surface, not something to fix here.
 */
export class TenantSecretNotFoundError extends Error {
  constructor(secretReference: string) {
    super(`No tenant database secret found at reference "${secretReference}"`);
    this.name = "TenantSecretNotFoundError";
  }
}

/**
 * Resolves the tenant's application role credential from its `secretReference`
 * (`tenant-databases/<tenant-id>`), validating the untyped `SecretStore` payload before ever
 * handing it back as a typed `TenantDatabaseCredential`. Mirrors
 * `ClusterAdminCredentialResolver` exactly, for the tenant secret namespace instead of the
 * cluster admin one — the two credentials are never resolved through the same code path.
 */
export interface TenantDatabaseCredentialResolver {
  resolve(secretReference: string): Promise<TenantDatabaseCredential>;
}

export function createTenantDatabaseCredentialResolver(
  secretStore: SecretStore,
): TenantDatabaseCredentialResolver {
  return {
    async resolve(secretReference: string): Promise<TenantDatabaseCredential> {
      const raw = await secretStore.get(secretReference);

      if (raw === undefined) {
        throw new TenantSecretNotFoundError(secretReference);
      }

      const result = tenantDatabaseCredentialSchema.safeParse(raw);
      if (!result.success) {
        const invalidPaths = result.error.issues.map((issue) => issue.path.join(".") || "(root)");
        throw new InvalidTenantSecretError(secretReference, invalidPaths);
      }

      return result.data;
    },
  };
}
