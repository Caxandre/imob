import type { FastifyInstance } from "fastify";

import { createTenant, type TenantRepository } from "../application/create-tenant.js";
import { TenantSlugAlreadyExistsError, type Tenant } from "../domain/tenant.js";
import { createTenantBodySchema } from "./create-tenant.schema.js";

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
  };
}
