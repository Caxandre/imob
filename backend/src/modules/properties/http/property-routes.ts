import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { resolveTenantContext } from "../../../app/tenant-context.js";
import type { TenantDatabaseConnectionManager } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { TenantDatabaseResolver } from "../../tenant-runtime/application/tenant-database-resolver.js";
import { createProperty } from "../application/create-property.js";
import { getProperty } from "../application/get-property.js";
import { listProperties } from "../application/list-properties.js";
import type { Property } from "../domain/property.js";
import { createDrizzlePropertyRepository } from "../infrastructure/drizzle-property-repository.js";
import { mapPropertyRouteError } from "./property-error-mapper.js";
import { tenantIdHeaderSchema } from "./property-openapi.schema.js";
import {
  createPropertyBodySchema,
  listPropertiesQuerySchema,
  propertyIdParamsSchema,
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
            "Lists properties in the tenant's own database, ordered by created_at DESC, id DESC.",
          tags: ["Properties"],
          headers: tenantIdHeaderSchema,
          querystring: {
            type: "object",
            properties: {
              page: { type: "integer", minimum: 1, description: "Defaults to 1." },
              limit: { type: "integer", minimum: 1, maximum: 100, description: "Defaults to 20, capped at 100." },
            },
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

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const result = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const repository = createDrizzlePropertyRepository(db);
          return listProperties(repository, { page: parsedQuery.data.page, limit: parsedQuery.data.limit });
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
  };
}
