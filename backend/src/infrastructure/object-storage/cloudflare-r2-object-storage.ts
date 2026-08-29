import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";

import type { GetObjectResult, ObjectStorage, PutObjectInput, StoredObject } from "./object-storage.js";
import {
  ObjectStorageConfigurationError,
  ObjectStorageDeleteError,
  ObjectStorageObjectNotFoundError,
  ObjectStorageReadError,
  ObjectStorageUploadError,
  validateObjectKey,
} from "./object-storage.js";

/**
 * Raw, possibly-incomplete configuration — matches the shape `env.R2_*` actually has (every
 * field optional at the global env-parse level, this task's section 6). Never read from `env`
 * directly inside this file (`redis-connection.ts`-style direct `env` imports aren't used here
 * on purpose) — the caller passes in whatever it resolved, keeping this adapter fully testable
 * with plain objects and free of any dependency on process env/config wiring.
 */
export interface CloudflareR2RawConfig {
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  publicUrl?: string;
}

export interface CloudflareR2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
}

/**
 * `.min(1)`/`.url()` custom messages are static strings, never templated with the actual
 * value — a config validation failure must never risk echoing a credential back (this task,
 * section 22/63).
 */
const cloudflareR2ConfigSchema = z.object({
  accountId: z.string().min(1, "accountId must be a non-empty string"),
  accessKeyId: z.string().min(1, "accessKeyId must be a non-empty string"),
  secretAccessKey: z.string().min(1, "secretAccessKey must be a non-empty string"),
  bucket: z.string().min(1, "bucket must be a non-empty string"),
  publicUrl: z.string().url("publicUrl must be a valid URL"),
});

/**
 * All-or-nothing (this task, section 7) — a config with, say, `bucket` set but `accountId`
 * missing throws `ObjectStorageConfigurationError` naming the missing/invalid fields, never
 * silently proceeds with a partial setup. `ObjectStorageConfigurationError` never receives a
 * value, only field names — see the schema comment above.
 */
function resolveConfig(raw: CloudflareR2RawConfig): CloudflareR2Config {
  const result = cloudflareR2ConfigSchema.safeParse(raw);
  if (!result.success) {
    const invalidFields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new ObjectStorageConfigurationError(invalidFields);
  }
  return result.data;
}

/** Cloudflare's documented R2 S3-compatible endpoint shape — never hardcode the account id. */
export function buildCloudflareR2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/**
 * `R2_PUBLIC_URL` + key, normalized to exactly one `/` between them (this task, section 13) —
 * never `.../path` (missing slash) nor `...//path` (doubled). Only trims slashes at the join
 * point; never otherwise alters the key content (section 13). `key` is expected to have already
 * passed `validateObjectKey` (never starts with `/`) — the leading-slash strip here is a
 * harmless no-op safety net, not the primary defense.
 */
export function buildPublicObjectUrl(publicUrlBase: string, key: string): string {
  const base = publicUrlBase.replace(/\/+$/, "");
  const trimmedKey = key.replace(/^\/+/, "");
  return `${base}/${trimmedKey}`;
}

/**
 * Minimal structural type for what this adapter actually calls on an S3 client — lets tests
 * inject a fake `{ send: vi.fn() }` instead of a real `S3Client`, so unit tests never hit the
 * network (this task, section 26), without inventing a broader abstraction than this adapter
 * needs.
 */
export interface S3GetObjectResponse {
  Body?: { transformToByteArray(): Promise<Uint8Array> };
  ContentType?: string;
  ContentLength?: number;
}

export interface S3CommandSender {
  send(command: PutObjectCommand | DeleteObjectCommand): Promise<unknown>;
  send(command: GetObjectCommand): Promise<S3GetObjectResponse>;
}

/**
 * Detects "the key does not exist" from whatever shape the AWS SDK v3 actually throws for S3
 * (Cloudflare R2's S3-compatible API included) — confined entirely to this file (Prompt 032,
 * section 61: the `ObjectStorage` port and every caller stay unaware that this check exists at
 * all, let alone what it looks for). `error.name === "NoSuchKey"` is the SDK's own modeled
 * exception name for this condition; the `$metadata.httpStatusCode === 404` fallback covers any
 * response the SDK doesn't map to that specific exception class but that is still, structurally,
 * a 404.
 */
function isNoSuchKeyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "NoSuchKey") {
    return true;
  }
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode === 404;
}

export interface CloudflareR2ObjectStorageDependencies {
  /** Test-only injection point. Production callers never pass this — a real `S3Client` is
   * always constructed from `config` when omitted. */
  client?: S3CommandSender;
}

/**
 * Real, `@aws-sdk/client-s3`-backed `ObjectStorage` adapter for Cloudflare R2 (ADR-006). The
 * SDK is confined entirely to this file — `object-storage.ts` (the port) and every future
 * domain/application consumer never import it (this task, section 9).
 *
 * `region: "auto"` and the `https://<accountId>.r2.cloudflarestorage.com` endpoint shape are
 * Cloudflare's own documented S3-compatibility configuration for the AWS SDK v3. `forcePathStyle:
 * false` (the SDK's own default, set explicitly here so the choice is visible and pinned rather
 * than relying on an implicit default — this task, section 18) matches that same documented
 * example; this repo has no live R2 credentials to verify it against a real bucket, so if a real
 * deployment ever sees bucket-not-found-style errors that plain path/bucket-name mistakes don't
 * explain, `forcePathStyle: true` is the first thing to try.
 *
 * Never sends `ACL: public-read` (section 20) — public accessibility is entirely a property of
 * how the R2 bucket/`R2_PUBLIC_URL` are configured outside this code, never a per-object S3 ACL.
 */
export function createCloudflareR2ObjectStorage(
  rawConfig: CloudflareR2RawConfig,
  deps: CloudflareR2ObjectStorageDependencies = {},
): ObjectStorage {
  const config = resolveConfig(rawConfig);

  const client: S3CommandSender =
    deps.client ??
    new S3Client({
      region: "auto",
      endpoint: buildCloudflareR2Endpoint(config.accountId),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: false,
    });

  return {
    async putObject(input: PutObjectInput): Promise<StoredObject> {
      validateObjectKey(input.key);

      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: input.key,
            Body: input.body,
            ContentType: input.contentType,
            ContentLength: input.contentLength,
          }),
        );
      } catch (error) {
        throw new ObjectStorageUploadError(config.bucket, input.key, error);
      }

      return { key: input.key, publicUrl: buildPublicObjectUrl(config.publicUrl, input.key) };
    },

    async getObject(key: string): Promise<GetObjectResult> {
      validateObjectKey(key);

      let response: S3GetObjectResponse;
      try {
        response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      } catch (error) {
        if (isNoSuchKeyError(error)) {
          throw new ObjectStorageObjectNotFoundError(key);
        }
        throw new ObjectStorageReadError(config.bucket, key, error);
      }

      if (!response.Body) {
        // Structurally unreachable through a real S3-compatible GetObject response (a 2xx
        // response always carries a body), but never assumed — a defensive, honest failure
        // instead of a downstream crash on `undefined.transformToByteArray()`.
        throw new ObjectStorageReadError(config.bucket, key, new Error("GetObject response had no Body"));
      }

      const bytes = await response.Body.transformToByteArray();
      return { body: Buffer.from(bytes), contentType: response.ContentType, contentLength: response.ContentLength };
    },

    async deleteObject(key: string): Promise<void> {
      validateObjectKey(key);

      try {
        // S3's DeleteObject is already idempotent — it succeeds even when the key doesn't
        // exist (this task, section 21). No read-before-delete, no special-casing here.
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      } catch (error) {
        throw new ObjectStorageDeleteError(config.bucket, key, error);
      }
    },
  };
}
