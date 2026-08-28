/**
 * Media (photos) attached to a property (Prompt 027) — metadata only, exactly as persisted in
 * `property_media` (Tenant Data Plane, `infrastructure/database/tenant/schema.ts`). The binary
 * itself lives entirely in Cloudflare R2 (ADR-006/ADR-007); nothing in this module ever holds
 * the object's bytes past the request that uploaded it. `objectKey` is carried on this domain
 * type for internal use (compensation delete, future delete-media work) but is deliberately
 * never serialized into the public HTTP response (`property-media-routes.ts` — this task,
 * section 44): it is an internal storage detail, not part of the API contract.
 */
export interface PropertyMedia {
  id: string;
  propertyId: string;
  objectKey: string;
  publicUrl: string;
  mimeType: PropertyMediaMimeType;
  sizeBytes: number;
  originalFilename: string | null;
  position: number;
  /**
   * At most one `true` per property (Prompt 028) — enforced by a partial unique index
   * (`property_media_one_cover_per_property`, `WHERE is_cover = true`), never only by
   * application logic. `false` for every row of a property with no cover selected yet.
   */
  isCover: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Raised when a media id does not exist, or exists but belongs to a different property/tenant
 * — the two cases are deliberately indistinguishable to the caller (404 either way, this task,
 * section 18/28), for the same cross-tenant-enumeration reason `PropertyNotFoundError` already
 * follows. */
export class PropertyMediaNotFoundError extends Error {
  readonly mediaId: string;

  constructor(mediaId: string) {
    super(`Property media "${mediaId}" was not found`);
    this.name = "PropertyMediaNotFoundError";
    this.mediaId = mediaId;
  }
}

/**
 * Raised by `reorder` when the submitted `media_ids` — after confirming every id genuinely
 * belongs to the property (else `PropertyMediaNotFoundError`, 404) — does not cover the
 * property's entire current gallery (this task, section 17/20). Maps to `409 Conflict`: the
 * submitted state conflicts with the gallery's actual current state, not a malformed request.
 */
export class PropertyMediaReorderMismatchError extends Error {
  readonly propertyId: string;

  constructor(propertyId: string) {
    super(`media_ids must contain exactly the property's current gallery (property "${propertyId}")`);
    this.name = "PropertyMediaReorderMismatchError";
    this.propertyId = propertyId;
  }
}

export type PropertyMediaMimeType = "image/jpeg" | "image/png" | "image/webp";

/**
 * Closed allowlist (this task, section 9) — deliberately excludes `image/svg+xml` (can embed
 * script), `image/gif`, and `application/octet-stream`. Mirrored manually as a raw SQL `CHECK`
 * constraint on `property_media.mime_type` (`infrastructure/database/tenant/schema.ts`) — kept
 * in sync by hand, since Drizzle schema code cannot import this Zod-adjacent domain constant
 * without inverting the established dependency direction (domain/application never depend on
 * http, but this list is domain-owned and http reuses it, same shape as `PROPERTY_TYPES` etc.
 * in `property-request.schema.ts`).
 */
export const ALLOWED_PROPERTY_MEDIA_MIME_TYPES: readonly PropertyMediaMimeType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

export function isAllowedPropertyMediaMimeType(value: string): value is PropertyMediaMimeType {
  return (ALLOWED_PROPERTY_MEDIA_MIME_TYPES as readonly string[]).includes(value);
}

const MIME_TYPE_EXTENSIONS: Record<PropertyMediaMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Never derived from a client-supplied filename/extension (this task, section 33) — always
 * from the already-validated MIME type, so the object key's extension can never be spoofed
 * independently of the actual declared/verified content type.
 */
export function extensionForMimeType(mimeType: PropertyMediaMimeType): string {
  return MIME_TYPE_EXTENSIONS[mimeType];
}
