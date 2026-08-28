import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { resolveTenantContext } from "../../../app/tenant-context.js";
import type { TenantDatabaseConnectionManager } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { TenantDatabaseResolver } from "../../tenant-runtime/application/tenant-database-resolver.js";
import { archiveProperty } from "../application/archive-property.js";
import { createProperty } from "../application/create-property.js";
import { getProperty } from "../application/get-property.js";
import { listProperties } from "../application/list-properties.js";
import { updateProperty } from "../application/update-property.js";
import type {
  ListPropertiesInput,
  PropertyListFilters,
  PropertySort,
  UpdatePropertyInput,
} from "../application/property-repository.js";
import type { Property } from "../domain/property.js";
import { createDrizzlePropertyRepository } from "../infrastructure/drizzle-property-repository.js";
import { mapPropertyRouteError } from "./property-error-mapper.js";
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
  };
}
