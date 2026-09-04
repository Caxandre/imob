import { randomUUID } from "node:crypto";

import type { ObjectStorage } from "../../../infrastructure/object-storage/object-storage.js";
import {
  extensionForMimeType,
  type PropertyMediaMimeType,
  type PropertyMediaWithVariants,
} from "../domain/property-media.js";
import { PropertyArchivedError, PropertyNotFoundError } from "../domain/property.js";
import type { CreatePropertyMediaInput, PropertyMediaRepository } from "./property-media-repository.js";
import type { PropertyRepository } from "./property-repository.js";

export interface UploadPropertyMediaInput {
  tenantId: string;
  propertyId: string;
  mimeType: PropertyMediaMimeType;
  body: Buffer;
  originalFilename: string | null;
}

/**
 * Never anything business-sensitive (title, address, client name/email) — only technical IDs
 * (this task, sections 31/46). `tenantId` is purely an R2 object-key namespacing detail here —
 * it is never written to `property_media` itself (no `tenant_id` column, CLAUDE.md/ADR-001).
 * The extension always comes from the already-validated `mimeType`, never from a client-supplied
 * filename/extension (section 33) — path traversal through the key is structurally impossible
 * (every segment is a UUID or a fixed literal).
 */
export function buildPropertyMediaObjectKey(params: {
  tenantId: string;
  propertyId: string;
  mediaId: string;
  mimeType: PropertyMediaMimeType;
}): string {
  const extension = extensionForMimeType(params.mimeType);
  return `tenants/${params.tenantId}/properties/${params.propertyId}/${params.mediaId}.${extension}`;
}

/**
 * Raised when the R2 upload succeeded but persisting `property_media` afterward failed (this
 * task, sections 35-37). A compensating `deleteObject()` is always attempted first;
 * `compensated` records whether it actually succeeded — `false` means the uploaded object is
 * now a known orphan in R2 that a future reconciliation process would need to find (not
 * implemented — see ADR-007's "Future" section). The original database error is always
 * preserved as `.cause`, never replaced or swallowed by the compensation outcome (section 36).
 */
export class PropertyMediaPersistError extends Error {
  readonly objectKey: string;
  readonly compensated: boolean;

  constructor(objectKey: string, compensated: boolean, cause: unknown) {
    super(
      `Failed to persist property_media metadata after uploading object "${objectKey}" ` +
        `(compensating delete ${compensated ? "succeeded" : "FAILED — object is now a likely orphan in R2"})`,
      { cause },
    );
    this.name = "PropertyMediaPersistError";
    this.objectKey = objectKey;
    this.compensated = compensated;
  }
}

/**
 * Uploads one property media file end to end (this task, section 34): validate the property
 * exists and is not archived → upload to R2 → insert `property_media`. PostgreSQL and R2 share
 * no transaction (section 85, ADR-007) — the R2 upload always happens first, strictly outside
 * any PostgreSQL transaction (CLAUDE.md: never hold a transaction open across an external
 * operation). A failure to persist metadata afterward triggers a best-effort compensating
 * delete (section 35/36) — never leaves a `property_media` row without a real backing object;
 * the inverse (an orphaned object with no row) is the one imperfection this strategy accepts,
 * documented in ADR-007.
 */
export async function uploadPropertyMedia(
  propertyRepository: PropertyRepository,
  propertyMediaRepository: PropertyMediaRepository,
  objectStorage: ObjectStorage,
  input: UploadPropertyMediaInput,
): Promise<PropertyMediaWithVariants> {
  const property = await propertyRepository.findById(input.propertyId);
  if (!property) {
    throw new PropertyNotFoundError(input.propertyId);
  }
  if (property.status === "INACTIVE") {
    throw new PropertyArchivedError(input.propertyId);
  }

  const mediaId = randomUUID();
  const objectKey = buildPropertyMediaObjectKey({
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    mediaId,
    mimeType: input.mimeType,
  });

  const stored = await objectStorage.putObject({
    key: objectKey,
    body: input.body,
    contentType: input.mimeType,
    contentLength: input.body.length,
  });

  const createInput: CreatePropertyMediaInput = {
    id: mediaId,
    propertyId: input.propertyId,
    objectKey: stored.key,
    publicUrl: stored.publicUrl,
    mimeType: input.mimeType,
    sizeBytes: input.body.length,
    originalFilename: input.originalFilename,
  };

  try {
    return await propertyMediaRepository.create(createInput);
  } catch (error) {
    let compensated = false;
    try {
      await objectStorage.deleteObject(stored.key);
      compensated = true;
    } catch {
      // Deliberately swallowed: the *original* `error` below must propagate — a failed
      // compensation is reported via `PropertyMediaPersistError.compensated`, never by
      // replacing the real cause with the cleanup failure (section 36).
    }
    throw new PropertyMediaPersistError(stored.key, compensated, error);
  }
}
