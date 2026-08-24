import type { SecretStore, TenantDatabaseSecret } from "../application/secret-store.js";

/**
 * Test-support only — an in-process, non-persistent SecretStore fake. Never promote this to
 * production: it holds real-shaped secrets in a plain JS Map with no encryption, no
 * durability, and no isolation between processes. Production needs a real secrets backend
 * (e.g. a cloud provider's Secrets Manager); building one is out of scope here.
 */
export function createInMemorySecretStore(): SecretStore {
  const secrets = new Map<string, TenantDatabaseSecret>();

  return {
    async put(secretReference: string, secret: TenantDatabaseSecret): Promise<void> {
      secrets.set(secretReference, secret);
    },

    async get(secretReference: string): Promise<TenantDatabaseSecret | undefined> {
      return secrets.get(secretReference);
    },

    async delete(secretReference: string): Promise<void> {
      secrets.delete(secretReference);
    },
  };
}
