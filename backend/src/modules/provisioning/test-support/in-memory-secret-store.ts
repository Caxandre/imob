import { env } from "../../../config/env.js";
import type { SecretStore } from "../application/secret-store.js";

/**
 * Test-support / local-development only — an in-process, non-persistent SecretStore fake.
 * Never promote this to production: it holds secret payloads in a plain JS Map with no
 * encryption, no durability, and no isolation between processes. Production needs a real
 * secrets backend (e.g. a cloud provider's Secrets Manager); building one is out of scope
 * here. Refuses to construct under NODE_ENV=production so it can never be wired in by
 * accident.
 */
export function createInMemorySecretStore(): SecretStore {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "createInMemorySecretStore is test/dev support only and must never run with NODE_ENV=production",
    );
  }

  const secrets = new Map<string, unknown>();

  return {
    async put(secretReference: string, value: unknown): Promise<void> {
      secrets.set(secretReference, value);
    },

    async get(secretReference: string): Promise<unknown | undefined> {
      return secrets.get(secretReference);
    },

    async delete(secretReference: string): Promise<void> {
      secrets.delete(secretReference);
    },
  };
}
