import type { FastifyInstance } from "fastify";

import { createTenant } from "../application/create-tenant.js";
import { listTenants } from "../application/list-tenants.js";
import type { TenantRepository } from "../application/tenant-repository.js";
import { TenantSlugAlreadyExistsError, type Tenant, type TenantListItem } from "../domain/tenant.js";
import { createTenantBodySchema } from "./create-tenant.schema.js";
import { listTenantsQuerySchema, MAX_PAGE_LIMIT } from "./list-tenants.schema.js";

function toResponse(tenant: Tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
  };
}

function toListItemResponse(item: TenantListItem) {
  return {
    ...toResponse(item),
    database: item.database
      ? {
          status: item.database.status,
          databaseName: item.database.databaseName,
          schemaVersion: item.database.schemaVersion,
          cluster: item.database.cluster
            ? {
                id: item.database.cluster.id,
                name: item.database.cluster.name,
                provider: item.database.cluster.provider,
                region: item.database.cluster.region,
                status: item.database.cluster.status,
              }
            : null,
        }
      : null,
  };
}

export function tenantRoutes(repository: TenantRepository) {
  return async function register(app: FastifyInstance) {
    app.post(
      "/tenants",
      {
        schema: {
          operationId: "createTenant",
          summary: "Create tenant",
          description:
            "Creates the tenant in the Control Plane and atomically records the intent to " +
            "provision its database. The tenant database itself is not created by this " +
            "endpoint — provisioning happens asynchronously afterwards.",
          tags: ["Tenants"],
          body: { $ref: "CreateTenantRequest#" },
          response: {
            201: { description: "Tenant created", $ref: "Tenant#" },
            400: { description: "Invalid payload", $ref: "ErrorResponse#" },
            409: { description: "Slug already in use", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      async (request, reply) => {
        const parsed = createTenantBodySchema.safeParse(request.body);

        if (!parsed.success) {
          return reply.status(400).send({
            statusCode: 400,
            error: "Bad Request",
            message: "Invalid request payload",
            details: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          });
        }

        try {
          const tenant = await createTenant(repository, parsed.data);

          request.log.info(
            { operation: "tenant.create", tenantId: tenant.id, slug: tenant.slug },
            "tenant created",
          );

          return reply.status(201).send(toResponse(tenant));
        } catch (error) {
          if (error instanceof TenantSlugAlreadyExistsError) {
            return reply.status(409).send({
              statusCode: 409,
              error: "Conflict",
              message: error.message,
            });
          }

          throw error;
        }
      },
    );

    app.get(
      "/tenants",
      {
        schema: {
          operationId: "listTenants",
          summary: "List tenants",
          description:
            "Administrative listing of tenants in the Control Plane, joined with a summary of " +
            "each tenant's registered database/cluster when available (database is null when " +
            "no tenant_databases row exists yet, e.g. a tenant still PROVISIONING). Reads " +
            "exclusively from the Control Plane — never opens a connection to any tenant's own " +
            "database. This route conceptually belongs to the Control Plane / administrative " +
            "API, not the tenant-scoped public API (see Properties). Administrative " +
            "authorization is PLANNED — no auth is enforced on this route yet. Unknown query " +
            "parameters are rejected with 400. With no parameters, defaults to created_at " +
            "DESC, id DESC.",
          tags: ["Tenants"],
          querystring: {
            type: "object",
            properties: {
              page: { type: "integer", minimum: 1, description: "Defaults to 1." },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: MAX_PAGE_LIMIT,
                description: `Defaults to 20, capped at ${String(MAX_PAGE_LIMIT)}.`,
              },
              status: {
                type: "string",
                enum: ["PROVISIONING", "READY", "FAILED", "SUSPENDED"],
                description: "Exact match.",
              },
              q: {
                type: "string",
                description:
                  "Case-insensitive substring match (ILIKE) over name and slug, trimmed. " +
                  "1-120 characters after trim.",
              },
            },
            examples: [{ status: "READY" }, { q: "central" }, { q: "central", status: "READY" }],
          },
          response: {
            200: { description: "Paginated list of tenants", $ref: "TenantList#" },
            400: { description: "Invalid query parameters", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      async (request, reply) => {
        const parsedQuery = listTenantsQuerySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          return reply.status(400).send({
            statusCode: 400,
            error: "Bad Request",
            message: "Invalid query parameters",
            details: parsedQuery.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          });
        }

        const query = parsedQuery.data;
        const result = await listTenants(repository, {
          page: query.page,
          limit: query.limit,
          filters: { status: query.status, query: query.q },
        });

        return reply.send({
          data: result.data.map(toListItemResponse),
          pagination: {
            page: result.pagination.page,
            limit: result.pagination.limit,
            total: result.pagination.total,
            total_pages: result.pagination.totalPages,
          },
        });
      },
    );
  };
}
