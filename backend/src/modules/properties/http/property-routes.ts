import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { resolveTenantContext } from "../../../app/tenant-context.js";
import type { ObjectStorage } from "../../../infrastructure/object-storage/object-storage.js";
import type { TenantDatabaseConnectionManager } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { TenantDatabaseResolver } from "../../tenant-runtime/application/tenant-database-resolver.js";
import { archiveProperty } from "../application/archive-property.js";
import { createProperty } from "../application/create-property.js";
import { deletePropertyMedia } from "../application/delete-property-media.js";
import { getProperty } from "../application/get-property.js";
import { listProperties } from "../application/list-properties.js";
import { listPropertyMedia } from "../application/list-property-media.js";
import { matchesDeclaredMimeType } from "../application/property-media-file-signature.js";
import type {
  ListPropertiesInput,
  PropertyListFilters,
  PropertySort,
  UpdatePropertyInput,
} from "../application/property-repository.js";
import { reorderPropertyMedia } from "../application/reorder-property-media.js";
import { setPropertyMediaCover } from "../application/set-property-media-cover.js";
import { updateProperty } from "../application/update-property.js";
import { uploadPropertyMedia } from "../application/upload-property-media.js";
import { ALLOWED_PROPERTY_MEDIA_MIME_TYPES, isAllowedPropertyMediaMimeType, type PropertyMedia } from "../domain/property-media.js";
import type { Property } from "../domain/property.js";
import { createDrizzlePropertyMediaRepository } from "../infrastructure/drizzle-property-media-repository.js";
import { createDrizzlePropertyRepository } from "../infrastructure/drizzle-property-repository.js";
import { mapPropertyRouteError } from "./property-error-mapper.js";
import {
  MAX_MEDIA_FILE_SIZE_BYTES,
  propertyMediaIdParamsSchema,
  reorderPropertyMediaBodySchema,
  sanitizeOriginalFilename,
} from "./property-media-request.schema.js";
import { tenantIdHeaderSchema } from "./property-openapi.schema.js";
import {
  createPropertyBodySchema,
  listPropertiesQuerySchema,
  PROPERTY_SORT_FIELDS,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  propertyIdParamsSchema,
  Q_MAX_LENGTH,
  Q_MIN_LENGTH,
  SORT_ORDERS,
  TRANSACTION_TYPES,
  updatePropertyBodySchema,
} from "./property-request.schema.js";

function toPropertyResponse(property: Property) {
  return {
    id: property.id,
    title: property.title,
    description: property.description,
    property_type: property.propertyType,
    transaction_type: property.transactionType,
    status: property.status,
    price: property.price,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    parking_spaces: property.parkingSpaces,
    area_m2: property.areaM2,
    street: property.street,
    number: property.number,
    complement: property.complement,
    neighborhood: property.neighborhood,
    city: property.city,
    state: property.state,
    postal_code: property.postalCode,
    created_at: property.createdAt.toISOString(),
    updated_at: property.updatedAt.toISOString(),
  };
}

/** `object_key` deliberately never appears here — internal storage detail, not public API
 * contract (this task, section 44). `public_url` is the persisted value from the upload, never
 * recomputed on read. */
function toPropertyMediaResponse(media: PropertyMedia) {
  return {
    id: media.id,
    property_id: media.propertyId,
    public_url: media.publicUrl,
    mime_type: media.mimeType,
    size_bytes: media.sizeBytes,
    original_filename: media.originalFilename,
    position: media.position,
    is_cover: media.isCover,
    created_at: media.createdAt.toISOString(),
    updated_at: media.updatedAt.toISOString(),
  };
}

/** `@fastify/multipart` errors (`fastify.multipartErrors`/thrown from `request.file()`) all
 * carry a stable `.code` — matching by code, not `instanceof`, avoids depending on the
 * decorator being present on every possible request/reply shape this function might see. */
function isMultipartErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code: unknown }).code === code;
}

function badRequest(
  reply: FastifyReply,
  message: string,
  issues: { path: PropertyKey[]; message: string }[],
) {
  return reply.status(400).send({
    statusCode: 400,
    error: "Bad Request",
    message,
    details: issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

/**
 * Wraps a handler so every Properties route shares the exact same error → HTTP mapping,
 * instead of repeating a try/catch per handler (this task, section 52). Anything
 * `mapPropertyRouteError` does not recognize is rethrown for the global error handler
 * (`build-app.ts`) to turn into the generic controlled 500.
 */
function withMappedErrors(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      const mapped = mapPropertyRouteError(error);
      if (mapped) {
        return reply.status(mapped.statusCode).send(mapped);
      }
      throw error;
    }
  };
}

export interface PropertyRoutesDependencies {
  tenantDatabaseResolver: TenantDatabaseResolver;
  tenantDatabaseConnectionManager: TenantDatabaseConnectionManager;
  /** Cloudflare R2 in real deployments (ADR-006), an in-memory fake in tests
   * (`test-support/in-memory-object-storage.ts`) — the media routes never import an adapter
   * directly (this task, section 49). */
  objectStorage: ObjectStorage;
}

/**
 * Registers the Properties HTTP routes. Every handler follows the same fixed path (this task,
 * section 30): request → `TenantContext` → `TenantDatabaseResolver` →
 * `TenantDatabaseConnectionManager` → a `PropertyRepository` scoped to that one tenant's
 * database → the use case. No handler ever sees `host`/`port`/`databaseName`/`secretReference`
 * — those live entirely behind `TenantDatabaseTarget`, resolved and consumed without leaving
 * this function.
 */
export function propertyRoutes(deps: PropertyRoutesDependencies) {
  return async function register(app: FastifyInstance) {
    // Scoped to this plugin context only (this task, section 21) — health/tenant routes,
    // registered separately in `build-app.ts`, never gain multipart parsing as a side effect.
    // `files: 1` is the primary mechanism behind "reject a request with more than one file"
    // (section 22); `fileSize` caps memory use during parsing itself, not only after fully
    // buffering (section 25) — both limits are re-asserted per `request.file()` call below too,
    // since @fastify/multipart honors the more specific per-call limits over these registration
    // defaults.
    await app.register(multipart, {
      limits: { fileSize: MAX_MEDIA_FILE_SIZE_BYTES, files: 1 },
    });

    app.post(
      "/properties",
      {
        schema: {
          operationId: "createProperty",
          summary: "Create property",
          description:
            "Creates a property in the tenant's own database (Tenant Data Plane). " +
            "X-Tenant-Id is a temporary development mechanism — see the header description.",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          body: { $ref: "CreatePropertyRequest#" },
          response: {
            201: { description: "Property created", $ref: "Property#" },
            400: { description: "Invalid payload or missing/invalid X-Tenant-Id", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsed = createPropertyBodySchema.safeParse(request.body);
        if (!parsed.success) {
          return badRequest(reply, "Invalid request payload", parsed.error.issues);
        }

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const property = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const repository = createDrizzlePropertyRepository(db);
          return createProperty(repository, {
            title: parsed.data.title,
            description: parsed.data.description,
            propertyType: parsed.data.property_type,
            transactionType: parsed.data.transaction_type,
            status: parsed.data.status,
            price: parsed.data.price,
            bedrooms: parsed.data.bedrooms,
            bathrooms: parsed.data.bathrooms,
            parkingSpaces: parsed.data.parking_spaces,
            areaM2: parsed.data.area_m2,
            street: parsed.data.street,
            number: parsed.data.number,
            complement: parsed.data.complement,
            neighborhood: parsed.data.neighborhood,
            city: parsed.data.city,
            state: parsed.data.state,
            postalCode: parsed.data.postal_code,
          });
        });

        request.log.info(
          { operation: "property.create", tenantId: tenantContext.tenantId, propertyId: property.id },
          "property created",
        );

        return reply.status(201).send(toPropertyResponse(property));
      }),
    );

    app.get(
      "/properties",
      {
        schema: {
          operationId: "listProperties",
          summary: "List properties",
          description:
            "Lists properties in the tenant's own database, with optional structured filters " +
            "(AND-combined), full-text search (q), and sorting. With no parameters, defaults " +
            "to created_at DESC, id DESC — the same behavior as before filters/sorting " +
            "existed. `q` performs a PostgreSQL Full Text Search (websearch_to_tsquery, " +
            "'portuguese' config) over title, description, street, neighborhood and city — " +
            "never ILIKE. Without an explicit `sort`, a query with `q` orders results by " +
            "relevance (best match first); an explicit `sort` always overrides relevance " +
            "ordering, even with `q` present. Unknown query parameters are rejected with 400. " +
            "Examples:\n" +
            "`/api/v1/properties?status=ACTIVE&property_type=APARTMENT&city=S%C3%A3o%20Paulo`\n" +
            "`/api/v1/properties?price_min=300000.00&price_max=600000.00&sort=price&order=asc`\n" +
            "`/api/v1/properties?q=apartamento+centro`\n" +
            "`/api/v1/properties?q=centro&status=ACTIVE&sort=price&order=asc`",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          querystring: {
            type: "object",
            properties: {
              page: { type: "integer", minimum: 1, description: "Defaults to 1." },
              limit: { type: "integer", minimum: 1, maximum: 100, description: "Defaults to 20, capped at 100." },
              status: { type: "string", enum: [...PROPERTY_STATUSES], description: "Exact match." },
              property_type: { type: "string", enum: [...PROPERTY_TYPES], description: "Exact match." },
              transaction_type: { type: "string", enum: [...TRANSACTION_TYPES], description: "Exact match." },
              city: {
                type: "string",
                description: "Case-insensitive, exact match after trim (e.g. \"São Paulo\").",
              },
              state: {
                type: "string",
                description: "Brazilian UF, 2 letters, normalized to uppercase (e.g. \"SP\").",
              },
              price_min: { type: "string", description: "Decimal string, > 0 (e.g. \"300000.00\")." },
              price_max: {
                type: "string",
                description: "Decimal string, > 0, must be >= price_min (e.g. \"600000.00\").",
              },
              bedrooms_min: { type: "integer", minimum: 0 },
              bathrooms_min: { type: "integer", minimum: 0 },
              parking_spaces_min: { type: "integer", minimum: 0 },
              area_min: { type: "string", description: "Decimal string, > 0 (e.g. \"60.00\")." },
              area_max: {
                type: "string",
                description: "Decimal string, > 0, must be >= area_min (e.g. \"120.00\").",
              },
              q: {
                type: "string",
                description:
                  "Full-text search over title, description, street, neighborhood and city " +
                  `(PostgreSQL websearch_to_tsquery, 'portuguese' config). ${String(Q_MIN_LENGTH)}-` +
                  `${String(Q_MAX_LENGTH)} characters after trim; supports natural input like ` +
                  "\"apartamento centro\", quoted phrases, and -exclusions.",
              },
              sort: {
                type: "string",
                enum: [...PROPERTY_SORT_FIELDS],
                description:
                  "Defaults to created_at — unless q is present and sort is omitted, in which " +
                  "case results are ordered by full-text relevance instead. Always tie-broken " +
                  "by id for stable pagination.",
              },
              order: {
                type: "string",
                enum: [...SORT_ORDERS],
                description: "Defaults to desc. Has no effect on relevance ordering (q without an explicit sort).",
              },
            },
            examples: [
              { status: "ACTIVE", property_type: "APARTMENT", city: "São Paulo", price_max: "600000.00" },
              { price_min: "300000.00", price_max: "600000.00", sort: "price", order: "asc" },
              { q: "apartamento centro" },
              { q: "centro", status: "ACTIVE", sort: "price", order: "asc" },
            ],
          },
          response: {
            200: { description: "Paginated list of properties", $ref: "PropertyList#" },
            400: { description: "Invalid query parameters or missing/invalid X-Tenant-Id", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedQuery = listPropertiesQuerySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          return badRequest(reply, "Invalid query parameters", parsedQuery.error.issues);
        }

        const query = parsedQuery.data;
        // Only defined filters are copied — the repository/SQL layer treats an absent key as
        // "no restriction on this column" (this task, section 29: the HTTP layer normalizes and
        // validates; it never builds SQL itself).
        const filters: PropertyListFilters = {
          status: query.status,
          propertyType: query.property_type,
          transactionType: query.transaction_type,
          city: query.city,
          state: query.state,
          priceMin: query.price_min,
          priceMax: query.price_max,
          bedroomsMin: query.bedrooms_min,
          bathroomsMin: query.bathrooms_min,
          parkingSpacesMin: query.parking_spaces_min,
          areaMin: query.area_min,
          areaMax: query.area_max,
          query: query.q,
        };
        // `sort` has no Zod default (unlike `order`) specifically so this can tell "omitted"
        // apart from "explicitly created_at" — with `q` present and `sort` omitted, relevance
        // wins; an explicit `sort` (any of the 5 allowlisted columns) always overrides it, even
        // with `q` present (this task, sections 19/20). "relevance" itself is never a value a
        // client can send — it is not part of `PROPERTY_SORT_FIELDS`/the querystring enum.
        const sort: PropertySort = query.sort ?? (query.q !== undefined ? "relevance" : "created_at");
        const listInput: ListPropertiesInput = {
          page: query.page,
          limit: query.limit,
          filters,
          sort,
          order: query.order,
        };

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const result = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const repository = createDrizzlePropertyRepository(db);
          return listProperties(repository, listInput);
        });

        return reply.send({
          data: result.data.map(toPropertyResponse),
          pagination: {
            page: result.pagination.page,
            limit: result.pagination.limit,
            total: result.pagination.total,
            total_pages: result.pagination.totalPages,
          },
        });
      }),
    );

    app.get(
      "/properties/:id",
      {
        schema: {
          operationId: "getProperty",
          summary: "Get property by id",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          params: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
          },
          response: {
            200: { description: "Property found", $ref: "Property#" },
            400: { description: "Invalid id or missing/invalid X-Tenant-Id", $ref: "ErrorResponse#" },
            404: { description: "Property not found", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = propertyIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid property id", parsedParams.error.issues);
        }

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const property = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const repository = createDrizzlePropertyRepository(db);
          return getProperty(repository, parsedParams.data.id);
        });

        return reply.send(toPropertyResponse(property));
      }),
    );

    app.patch(
      "/properties/:id",
      {
        schema: {
          operationId: "updateProperty",
          summary: "Update property",
          description:
            "Partially updates a property in the tenant's own database. Any subset of the " +
            "editable fields may be sent; fields omitted from the body are left unchanged. " +
            "id/created_at/updated_at are immutable and rejected if present in the body.",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          params: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
          },
          body: { $ref: "UpdatePropertyRequest#" },
          response: {
            200: { description: "Property updated", $ref: "Property#" },
            400: { description: "Invalid payload, empty body, or missing/invalid X-Tenant-Id", $ref: "ErrorResponse#" },
            404: { description: "Property not found", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = propertyIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid property id", parsedParams.error.issues);
        }

        const parsedBody = updatePropertyBodySchema.safeParse(request.body);
        if (!parsedBody.success) {
          return badRequest(reply, "Invalid request payload", parsedBody.error.issues);
        }

        // Only keys actually present in the parsed body are copied — an omitted key must
        // never be confused with an explicit `null` (sections 43/44). Zod never backfills an
        // omitted optional key, so `"x" in parsedBody.data` is exactly "was it sent".
        const input: UpdatePropertyInput = {};
        const body = parsedBody.data;
        if ("title" in body) input.title = body.title;
        if ("description" in body) input.description = body.description;
        if ("property_type" in body) input.propertyType = body.property_type;
        if ("transaction_type" in body) input.transactionType = body.transaction_type;
        if ("status" in body) input.status = body.status;
        if ("price" in body) input.price = body.price;
        if ("bedrooms" in body) input.bedrooms = body.bedrooms;
        if ("bathrooms" in body) input.bathrooms = body.bathrooms;
        if ("parking_spaces" in body) input.parkingSpaces = body.parking_spaces;
        if ("area_m2" in body) input.areaM2 = body.area_m2;
        if ("street" in body) input.street = body.street;
        if ("number" in body) input.number = body.number;
        if ("complement" in body) input.complement = body.complement;
        if ("neighborhood" in body) input.neighborhood = body.neighborhood;
        if ("city" in body) input.city = body.city;
        if ("state" in body) input.state = body.state;
        if ("postal_code" in body) input.postalCode = body.postal_code;

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const property = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const repository = createDrizzlePropertyRepository(db);
          return updateProperty(repository, parsedParams.data.id, input);
        });

        request.log.info(
          { operation: "property.update", tenantId: tenantContext.tenantId, propertyId: property.id },
          "property updated",
        );

        return reply.send(toPropertyResponse(property));
      }),
    );

    app.delete(
      "/properties/:id",
      {
        schema: {
          operationId: "archiveProperty",
          summary: "Archive property",
          description:
            "Archives a property (status = INACTIVE) in the tenant's own database. Never a " +
            "physical delete — the row and its history are preserved. Idempotent: archiving " +
            "an already-INACTIVE property still succeeds.",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          params: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
          },
          response: {
            204: { description: "Property archived (or already was)" },
            400: { description: "Invalid id or missing/invalid X-Tenant-Id", $ref: "ErrorResponse#" },
            404: { description: "Property not found", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = propertyIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid property id", parsedParams.error.issues);
        }

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const property = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const repository = createDrizzlePropertyRepository(db);
          return archiveProperty(repository, parsedParams.data.id);
        });

        request.log.info(
          { operation: "property.archive", tenantId: tenantContext.tenantId, propertyId: property.id },
          "property archived",
        );

        return reply.status(204).send();
      }),
    );

    app.post(
      "/properties/:id/media",
      {
        schema: {
          operationId: "uploadPropertyMedia",
          summary: "Upload property media",
          description:
            "Uploads a single image for a property to Cloudflare R2 and records its metadata " +
            "in the tenant's own database. multipart/form-data with a single field named " +
            `"file" (binary), at most ${String(MAX_MEDIA_FILE_SIZE_BYTES / (1024 * 1024))}MB, ` +
            `one of: ${ALLOWED_PROPERTY_MEDIA_MIME_TYPES.join(", ")} — validated both by the ` +
            "declared Content-Type and by the file's own magic bytes, never by filename/" +
            "extension alone. Rejected (409) for an archived (INACTIVE) property. See the " +
            "UploadPropertyMediaRequest schema for the field contract.",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          // Deliberately NO `body` schema here (this task, section 65/69 — verified
          // empirically before settling on this): `@fastify/multipart` in streaming mode
          // (no `attachFieldsToBody`) never populates `request.body` at all, so a `body`
          // schema would make Fastify's AJV validate `undefined` against an object schema and
          // reject every real multipart upload with 400 before this handler even runs. Swagger
          // documentation for the multipart contract instead comes from `consumes` plus the
          // registered `UploadPropertyMediaRequest` component (referenced in the description
          // below) — file validation itself is fully manual in the handler (presence, MIME
          // allowlist, magic bytes).
          consumes: ["multipart/form-data"],
          params: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
          },
          response: {
            201: { description: "Media uploaded", $ref: "PropertyMedia#" },
            400: {
              description: "Invalid id, missing/invalid file, unsupported type, or missing/invalid X-Tenant-Id",
              $ref: "ErrorResponse#",
            },
            404: { description: "Property not found", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY, or the property is archived (INACTIVE)", $ref: "ErrorResponse#" },
            413: { description: "File exceeds the maximum allowed size", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = propertyIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid property id", parsedParams.error.issues);
        }

        let uploadedFile;
        let buffer: Buffer;
        try {
          uploadedFile = await request.file({ limits: { fileSize: MAX_MEDIA_FILE_SIZE_BYTES, files: 1 } });
          if (!uploadedFile) {
            return badRequest(reply, 'A file is required (multipart field "file")', []);
          }
          buffer = await uploadedFile.toBuffer();
        } catch (error) {
          if (isMultipartErrorWithCode(error, "FST_REQ_FILE_TOO_LARGE")) {
            return reply.status(413).send({
              statusCode: 413,
              error: "Payload Too Large",
              message: `File exceeds the maximum allowed size of ${String(MAX_MEDIA_FILE_SIZE_BYTES)} bytes`,
            });
          }
          if (isMultipartErrorWithCode(error, "FST_FILES_LIMIT")) {
            return badRequest(reply, "Only one file may be uploaded per request", []);
          }
          // Empirically (not just per the library's documented `FilesLimitError`/413 path),
          // busboy's `filesLimit` cleanup closes the first file's stream mid-read when a
          // second file part arrives while `toBuffer()` is still consuming it — surfacing as
          // this Node stream error instead, not a `@fastify/multipart` error class. Also the
          // honest, generic outcome for a client that genuinely disconnects mid-upload, so the
          // message stays general rather than presuming "too many files" specifically.
          if (isMultipartErrorWithCode(error, "ERR_STREAM_PREMATURE_CLOSE")) {
            return badRequest(reply, "The upload was interrupted, or included more than one file", []);
          }
          // Anything else (malformed multipart body, wrong content type, ...) is safely
          // sanitized into a generic 500 by the global error handler (build-app.ts) — never a
          // raw parser error surfaced to the client (this task, section 59).
          throw error;
        }

        if (uploadedFile.fieldname !== "file") {
          return badRequest(reply, 'The file field must be named "file"', []);
        }
        if (!isAllowedPropertyMediaMimeType(uploadedFile.mimetype)) {
          return badRequest(
            reply,
            `Unsupported file type "${uploadedFile.mimetype}" — allowed: ${ALLOWED_PROPERTY_MEDIA_MIME_TYPES.join(", ")}`,
            [],
          );
        }
        if (!matchesDeclaredMimeType(uploadedFile.mimetype, buffer)) {
          return badRequest(reply, "File content does not match its declared type", []);
        }
        // Narrowed to `PropertyMediaMimeType` by the `isAllowedPropertyMediaMimeType` check
        // above — captured into a `const` here because TypeScript does not carry that
        // narrowing through the closure passed to `withTenantDatabase` below.
        const mimeType = uploadedFile.mimetype;

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const media = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const propertyRepository = createDrizzlePropertyRepository(db);
          const propertyMediaRepository = createDrizzlePropertyMediaRepository(db);
          return uploadPropertyMedia(propertyRepository, propertyMediaRepository, deps.objectStorage, {
            tenantId: tenantContext.tenantId,
            propertyId: parsedParams.data.id,
            mimeType,
            body: buffer,
            originalFilename: sanitizeOriginalFilename(uploadedFile.filename),
          });
        });

        request.log.info(
          {
            operation: "property.media.upload",
            tenantId: tenantContext.tenantId,
            propertyId: parsedParams.data.id,
            mediaId: media.id,
          },
          "property media uploaded",
        );

        return reply.status(201).send(toPropertyMediaResponse(media));
      }),
    );

    app.get(
      "/properties/:id/media",
      {
        schema: {
          operationId: "listPropertyMedia",
          summary: "List property media",
          description:
            "Lists a property's media (photos), ordered position ASC, id ASC. Media of an " +
            "archived (INACTIVE) property remains listable — archiving never hides media.",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          params: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
          },
          response: {
            200: { description: "Property media list", $ref: "PropertyMediaList#" },
            400: { description: "Invalid id or missing/invalid X-Tenant-Id", $ref: "ErrorResponse#" },
            404: { description: "Property not found", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = propertyIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid property id", parsedParams.error.issues);
        }

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const mediaList = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const propertyRepository = createDrizzlePropertyRepository(db);
          const propertyMediaRepository = createDrizzlePropertyMediaRepository(db);
          return listPropertyMedia(propertyRepository, propertyMediaRepository, parsedParams.data.id);
        });

        return reply.send({ data: mediaList.map(toPropertyMediaResponse) });
      }),
    );

    app.put(
      "/properties/:id/media/order",
      {
        schema: {
          operationId: "reorderPropertyMedia",
          summary: "Reorder property media gallery",
          description:
            "Replaces a property's entire gallery order. media_ids must contain exactly the " +
            "property's current media ids (no fewer, no more, no duplicates) — media_ids[0] " +
            "becomes position 0, and so on. An empty array is only accepted as a no-op when " +
            "the property currently has zero media; otherwise it is rejected as a mismatch. " +
            "Never changes which media is the cover. Allowed for an archived (INACTIVE) " +
            "property — this is gallery maintenance, not adding new content.",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          params: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
          },
          body: { $ref: "ReorderPropertyMediaRequest#" },
          response: {
            200: { description: "Gallery reordered", $ref: "PropertyMediaList#" },
            400: {
              description: "Invalid id, invalid/duplicate media ids, or missing/invalid X-Tenant-Id",
              $ref: "ErrorResponse#",
            },
            404: {
              description: "Property not found, or a submitted media id does not belong to it",
              $ref: "ErrorResponse#",
            },
            409: {
              description: "Tenant is not READY, or media_ids does not exactly match the current gallery",
              $ref: "ErrorResponse#",
            },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = propertyIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid property id", parsedParams.error.issues);
        }

        const parsedBody = reorderPropertyMediaBodySchema.safeParse(request.body);
        if (!parsedBody.success) {
          return badRequest(reply, "Invalid request payload", parsedBody.error.issues);
        }

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const mediaList = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const propertyRepository = createDrizzlePropertyRepository(db);
          const propertyMediaRepository = createDrizzlePropertyMediaRepository(db);
          return reorderPropertyMedia(propertyRepository, propertyMediaRepository, parsedParams.data.id, parsedBody.data.media_ids);
        });

        request.log.info(
          { operation: "property.media.reorder", tenantId: tenantContext.tenantId, propertyId: parsedParams.data.id },
          "property media reordered",
        );

        return reply.send({ data: mediaList.map(toPropertyMediaResponse) });
      }),
    );

    app.patch(
      "/properties/:id/media/:mediaId/cover",
      {
        schema: {
          operationId: "setPropertyMediaCover",
          summary: "Set property media cover",
          description:
            "Sets one media as the property's cover, unsetting any previous one. Idempotent — " +
            "selecting the media that is already the cover still returns 200. Allowed for an " +
            "archived (INACTIVE) property — this is gallery maintenance, not adding new content.",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              mediaId: { type: "string", format: "uuid" },
            },
            required: ["id", "mediaId"],
          },
          response: {
            200: { description: "Cover set", $ref: "PropertyMedia#" },
            400: { description: "Invalid id/mediaId or missing/invalid X-Tenant-Id", $ref: "ErrorResponse#" },
            404: { description: "Property not found, or media does not belong to it", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = propertyMediaIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid property id or media id", parsedParams.error.issues);
        }

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const media = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const propertyRepository = createDrizzlePropertyRepository(db);
          const propertyMediaRepository = createDrizzlePropertyMediaRepository(db);
          return setPropertyMediaCover(propertyRepository, propertyMediaRepository, parsedParams.data.id, parsedParams.data.mediaId);
        });

        request.log.info(
          {
            operation: "property.media.setCover",
            tenantId: tenantContext.tenantId,
            propertyId: parsedParams.data.id,
            mediaId: parsedParams.data.mediaId,
          },
          "property media cover set",
        );

        return reply.send(toPropertyMediaResponse(media));
      }),
    );

    app.delete(
      "/properties/:id/media/:mediaId",
      {
        schema: {
          operationId: "deletePropertyMedia",
          summary: "Delete property media",
          description:
            "Removes one media from a property's gallery. The tenant database metadata is " +
            "removed first, remaining positions are reindexed to a gapless 0..N-1, and — if the " +
            "deleted media was the cover and others remain — the new position-0 media " +
            "automatically becomes the new cover. Only after that database transaction commits " +
            "is the underlying Cloudflare R2 object deleted, on a best-effort basis: a failure " +
            "there does not fail the request (it is logged server-side; the object may remain " +
            "as an orphan for future reconciliation). Allowed for an archived (INACTIVE) " +
            "property — this is gallery maintenance, not adding new content.",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              mediaId: { type: "string", format: "uuid" },
            },
            required: ["id", "mediaId"],
          },
          response: {
            204: { description: "Media deleted" },
            400: { description: "Invalid id/mediaId or missing/invalid X-Tenant-Id", $ref: "ErrorResponse#" },
            404: { description: "Property not found, or media does not belong to it", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = propertyMediaIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid property id or media id", parsedParams.error.issues);
        }

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const outcome = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const propertyRepository = createDrizzlePropertyRepository(db);
          const propertyMediaRepository = createDrizzlePropertyMediaRepository(db);
          return deletePropertyMedia(
            propertyRepository,
            propertyMediaRepository,
            deps.objectStorage,
            parsedParams.data.id,
            parsedParams.data.mediaId,
          );
        });

        if (!outcome.objectStorageDeleted) {
          // Metadata removal already committed — this is a best-effort cleanup failure, never
          // a reason to fail the request (ADR-007 "Delete"). Never logs a secret; only the
          // identifiers needed to find/reconcile the orphaned object later.
          request.log.warn(
            {
              operation: "property.media.delete.objectStorageFailed",
              tenantId: tenantContext.tenantId,
              propertyId: parsedParams.data.id,
              mediaId: parsedParams.data.mediaId,
              objectKey: outcome.objectKey,
            },
            "property media metadata deleted, but the object storage delete failed — object may be orphaned",
          );
        }

        request.log.info(
          {
            operation: "property.media.delete",
            tenantId: tenantContext.tenantId,
            propertyId: parsedParams.data.id,
            mediaId: parsedParams.data.mediaId,
          },
          "property media deleted",
        );

        return reply.status(204).send();
      }),
    );
  };
}
