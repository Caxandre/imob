import {
  ObjectStorageObjectNotFoundError,
  validateObjectKey,
  type GetObjectResult,
  type ObjectStorage,
  type PutObjectInput,
  type StoredObject,
} from "../object-storage.js";

/**
 * Test-support / local-development only — an in-process, non-persistent `ObjectStorage` fake,
 * the same convention as `createInMemorySecretStore` (`modules/provisioning/test-support/`).
 * Never used as a runtime fallback (this task, section 55/56) — `buildApp()` always requires an
 * explicit `ObjectStorage` from its caller; only test-support code (`build-test-app.ts`)
 * constructs this one, explicitly, never silently.
 */
const FAKE_PUBLIC_BASE = "https://in-memory-object-storage.test";

export interface InMemoryStoredObject {
  body: Uint8Array | Buffer;
  contentType: string;
}

export interface InMemoryObjectStorage extends ObjectStorage {
  /** Test-only introspection — never part of the `ObjectStorage` port itself. */
  has(key: string): boolean;
  get(key: string): InMemoryStoredObject | undefined;
}

export function createInMemoryObjectStorage(): InMemoryObjectStorage {
  const objects = new Map<string, InMemoryStoredObject>();

  return {
    async putObject(input: PutObjectInput): Promise<StoredObject> {
      validateObjectKey(input.key);
      objects.set(input.key, { body: input.body, contentType: input.contentType });
      return { key: input.key, publicUrl: `${FAKE_PUBLIC_BASE}/${input.key}` };
    },

    async getObject(key: string): Promise<GetObjectResult> {
      validateObjectKey(key);
      const stored = objects.get(key);
      if (!stored) {
        throw new ObjectStorageObjectNotFoundError(key);
      }
      const body = Buffer.isBuffer(stored.body) ? stored.body : Buffer.from(stored.body);
      return { body, contentType: stored.contentType, contentLength: body.length };
    },

    async deleteObject(key: string): Promise<void> {
      validateObjectKey(key);
      // Map#delete on a missing key is already a no-op — idempotent for free, matching the
      // real R2 adapter's own DeleteObject semantics.
      objects.delete(key);
    },

    has(key: string): boolean {
      return objects.has(key);
    },

    get(key: string): InMemoryStoredObject | undefined {
      return objects.get(key);
    },
  };
}
