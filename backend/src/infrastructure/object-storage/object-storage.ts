/**
 * Provider-agnostic port for persisting binary objects (Prompt 026, ADR-006) — property media
 * (Prompt 027) was the first real consumer of `putObject`/`deleteObject`; the media processing
 * worker (Prompt 032) is the first consumer of `getObject` (it needs to read back the original
 * to generate variants). Domain/application code depends only on this interface, never on
 * `@aws-sdk/client-s3` or any other provider SDK — that stays confined to the adapter
 * (`cloudflare-r2-object-storage.ts`). Deliberately minimal: no `listObjects`/`copyObject`/
 * presigned URLs/multipart until a real consumer needs them.
 */
export interface PutObjectInput {
  key: string;
  body: Uint8Array | Buffer;
  contentType: string;
  contentLength?: number;
}

export interface StoredObject {
  key: string;
  publicUrl: string;
}

/**
 * Materialized as a `Buffer` — never a stream (Prompt 032, section 18): the upload path this
 * object is always read back from already caps the original at `MAX_MEDIA_FILE_SIZE_BYTES`
 * (10MB, Prompt 027), so buffering the whole object in memory is an acceptable simplification
 * for this first version. Streaming is a future refinement, not implemented here.
 */
export interface GetObjectResult {
  body: Buffer;
  contentType?: string;
  contentLength?: number;
}

export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  /**
   * Reads an object back in full (Prompt 032). Rejects with {@link ObjectStorageObjectNotFoundError}
   * when the key genuinely does not exist in the provider — a provider-agnostic classification
   * (never an SDK-specific error code/type leaking past the adapter, section 61) that callers
   * may treat as a permanent condition; any other failure rejects with
   * {@link ObjectStorageReadError} and should be treated as transient.
   */
  getObject(key: string): Promise<GetObjectResult>;
  /** Idempotent — deleting a key that doesn't exist must never throw (this task, section 21). */
  deleteObject(key: string): Promise<void>;
}

/** Raised by `validateObjectKey` — never includes any credential, only the offending key. */
export class InvalidObjectKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`Invalid object key "${key}": ${reason}`);
    this.name = "InvalidObjectKeyError";
  }
}

/**
 * Minimal safety checks shared by every `ObjectStorage` adapter (this task, section 14) — the
 * port owns this rule, not any one provider's adapter, so a future second adapter gets it for
 * free. Deliberately not a path DSL: just enough to reject the obviously inconsistent/dangerous
 * shapes (empty, absolute-looking, or containing a `..` traversal segment) without inventing
 * validation the caller (the future media-organizing layer, Prompt 027) hasn't asked for yet —
 * this port never decides *what* a key should look like (section 11), only that it isn't
 * obviously broken.
 */
export function validateObjectKey(key: string): void {
  if (key.length === 0) {
    throw new InvalidObjectKeyError(key, "must not be empty");
  }
  if (key.startsWith("/")) {
    throw new InvalidObjectKeyError(key, 'must not start with "/"');
  }
  if (key.split("/").includes("..")) {
    throw new InvalidObjectKeyError(key, 'must not contain a ".." path segment');
  }
}

/**
 * Raised by an adapter's factory when its configuration is missing or incomplete (this task,
 * section 7) — some but not all of the required settings present is never accepted silently.
 * Names only the missing/invalid fields, never a value (there is nothing to leak: an absent or
 * malformed setting has no secret value worth hiding, but the field name alone is enough to fix
 * the configuration).
 */
export class ObjectStorageConfigurationError extends Error {
  constructor(invalidFields: string[]) {
    super(`Object storage is not fully configured — missing/invalid: ${invalidFields.join(", ")}`);
    this.name = "ObjectStorageConfigurationError";
  }
}

/**
 * Raised when the underlying provider rejects a `putObject`/`deleteObject` call. Message never
 * includes credentials, the raw SDK request, or provider error internals — only the operation,
 * bucket, and key (all safe to log per this task's section 24). The original error is preserved
 * as `cause` for internal debugging only; callers/loggers must never serialize it into a public
 * response (see `property-error-mapper.ts`-style boundary mapping once a real HTTP consumer
 * exists).
 */
export class ObjectStorageUploadError extends Error {
  constructor(bucket: string, key: string, cause?: unknown) {
    super(`Failed to upload object "${key}" to bucket "${bucket}"`, cause === undefined ? undefined : { cause });
    this.name = "ObjectStorageUploadError";
  }
}

export class ObjectStorageDeleteError extends Error {
  constructor(bucket: string, key: string, cause?: unknown) {
    super(`Failed to delete object "${key}" from bucket "${bucket}"`, cause === undefined ? undefined : { cause });
    this.name = "ObjectStorageDeleteError";
  }
}

/**
 * Raised when the underlying provider rejects a `getObject` call for a reason other than the key
 * genuinely not existing (see {@link ObjectStorageObjectNotFoundError} for that case) — same
 * safety guarantees as `ObjectStorageUploadError`/`ObjectStorageDeleteError` (never credentials,
 * raw SDK request, or `Authorization` headers; original cause preserved only in `.cause`).
 * Callers should treat this as transient (Prompt 032, section 61) — e.g. R2 unreachable, a
 * network error — never a reason to give up permanently on their own.
 */
export class ObjectStorageReadError extends Error {
  constructor(bucket: string, key: string, cause?: unknown) {
    super(`Failed to read object "${key}" from bucket "${bucket}"`, cause === undefined ? undefined : { cause });
    this.name = "ObjectStorageReadError";
  }
}

/**
 * Raised by `getObject` when the provider confirms the key does not exist — a provider-agnostic
 * classification an adapter derives from whatever SDK-specific signal it has (e.g. S3's
 * `NoSuchKey`/404), never leaked past the adapter boundary (Prompt 032, section 61: "não acoplar
 * application layer a códigos do SDK AWS"). Callers may treat this as a permanent condition —
 * retrying a genuinely missing object can never succeed.
 */
export class ObjectStorageObjectNotFoundError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Object "${key}" was not found`);
    this.name = "ObjectStorageObjectNotFoundError";
    this.key = key;
  }
}
