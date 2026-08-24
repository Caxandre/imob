import type { ClusterAdminCredential } from "./database-credential.js";
import { clusterAdminCredentialSchema } from "./database-credential.js";
import type { SecretStore } from "./secret-store.js";

/**
 * Raised when `SecretStore.get()` finds nothing at the given reference. Never includes the
 * secret itself (there is none to include) — only the reference, which is a pointer, not a
 * credential.
 */
export class ClusterAdminSecretNotFoundError extends Error {
  constructor(secretReference: string) {
    super(`No cluster admin secret found at reference "${secretReference}"`);
    this.name = "ClusterAdminSecretNotFoundError";
  }
}

/**
 * Raised when a secret exists at the reference but fails validation against
 * `clusterAdminCredentialSchema`. Never includes the payload or the Zod issue values — those
 * could echo back a password. Only the reference and the field paths that failed.
 */
export class InvalidClusterAdminSecretError extends Error {
  constructor(secretReference: string, invalidPaths: string[]) {
    super(
      `Cluster admin secret at reference "${secretReference}" failed validation (fields: ${invalidPaths.join(", ") || "unknown"})`,
    );
    this.name = "InvalidClusterAdminSecretError";
  }
}

/**
 * Resolves the cluster's administrative credential from its `secretReference`
 * (`database_clusters.secretReference`), validating the untyped `SecretStore` payload before
 * ever handing it back as a typed `ClusterAdminCredential`.
 */
export interface ClusterAdminCredentialResolver {
  resolve(secretReference: string): Promise<ClusterAdminCredential>;
}

export function createClusterAdminCredentialResolver(
  secretStore: SecretStore,
): ClusterAdminCredentialResolver {
  return {
    async resolve(secretReference: string): Promise<ClusterAdminCredential> {
      const raw = await secretStore.get(secretReference);

      if (raw === undefined) {
        throw new ClusterAdminSecretNotFoundError(secretReference);
      }

      const result = clusterAdminCredentialSchema.safeParse(raw);
      if (!result.success) {
        const invalidPaths = result.error.issues.map((issue) => issue.path.join(".") || "(root)");
        throw new InvalidClusterAdminSecretError(secretReference, invalidPaths);
      }

      return result.data;
    },
  };
}
