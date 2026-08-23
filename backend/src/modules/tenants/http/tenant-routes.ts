import type { FastifyInstance } from "fastify";

import { createTenant, type TenantRepository } from "../application/create-tenant.js";
import { TenantSlugAlreadyExistsError, type Tenant } from "../domain/tenant.js";
import {
  createTenantBodySchema,
  NAME_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
} from "./create-tenant.schema.js";

const errorResponseSchema = {
  type: "object",
  properties: {
    statusCode: { type: "integer" },
    error: { type: "string" },
    message: { type: "string" },
    details: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          message: { type: "string" },
        },
        required: ["path", "message"],
      },
    },
  },
  required: ["statusCode", "error", "message"],
} as const;

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
          summary: "Create a tenant in the Control Plane",
          description:
            "Registers a new tenant with status PROVISIONING. No tenant database is " +
            "provisioned by this endpoint.",
          tags: ["tenants"],
          body: {
            type: "object",
            // Length and format rules are enforced by Zod after normalization (trim, and
            // lowercase for slug), which JSON Schema cannot express on the raw payload.
            properties: {
              name: {
                type: "string",
                description: `Display name. Trimmed; must not be empty and must be at most ${NAME_MAX_LENGTH} characters after trimming.`,
              },
              slug: {
                type: "string",
                description: `Public identifier. Trimmed and lowercased, then must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be between ${SLUG_MIN_LENGTH} and ${SLUG_MAX_LENGTH} characters.`,
              },
            },
            required: ["name", "slug"],
          },
          response: {
            201: {
              description: "Tenant created",
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                name: { type: "string" },
                slug: { type: "string" },
                status: { type: "string", enum: ["PROVISIONING"] },
                createdAt: { type: "string", format: "date-time" },
                updatedAt: { type: "string", format: "date-time" },
              },
              required: ["id", "name", "slug", "status", "createdAt", "updatedAt"],
            },
            400: { description: "Invalid payload", ...errorResponseSchema },
            409: { description: "Slug already in use", ...errorResponseSchema },
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
