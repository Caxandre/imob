import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { controlPlaneDb } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { createDrizzleTenantRepository } from "../modules/tenants/infrastructure/drizzle-tenant-repository.js";
import { tenantRoutes } from "../modules/tenants/http/tenant-routes.js";
import { createTenantRequestSchema, tenantSchema } from "../modules/tenants/http/tenant-openapi.schema.js";
import { healthRoute } from "./routes/health.route.js";
import { errorResponseSchema } from "./schemas/error-response.schema.js";
import { healthResponseSchema } from "./schemas/health-response.schema.js";

export function buildApp(): FastifyInstance {
  const app = fastify({
    logger: createLoggerOptions(),
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    request.log.error({ err: error }, "request failed");

    if (statusCode < 500) {
      reply.status(statusCode).send({
        statusCode,
        error: error.name,
        message: error.message,
      });
      return;
    }

    reply.status(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    });
  });

  void app.register(swagger, {
    // Without this, every named schema below (registered via app.addSchema) would show up
    // in the spec's components.schemas as an opaque "def-0", "def-1", ... — the plugin's own
    // default naming — instead of "ErrorResponse", "Tenant", etc.
    refResolver: {
      buildLocalReference: (json: { $id?: string }, _baseUri: unknown, _fragment: unknown, i: number) =>
        json.$id ?? `def-${i}`,
    },
    openapi: {
      info: {
        title: "Imob API",
        description: "API do SaaS imobiliário multi-tenant.",
        // Kept in sync with package.json manually — no build step reads it dynamically yet.
        version: "0.1.0",
      },
      tags: [
        { name: "System", description: "Operational endpoints (health, readiness)." },
        { name: "Tenants", description: "Tenant lifecycle in the Control Plane." },
      ],
    },
  });

  void app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // Shared, named response/request schemas — registered once here so every route schema
  // references the exact same definition via $ref instead of a copy that could drift.
  app.addSchema(errorResponseSchema);
  app.addSchema(healthResponseSchema);
  app.addSchema(createTenantRequestSchema);
  app.addSchema(tenantSchema);

  void app.register(healthRoute);

  const tenantRepository = createDrizzleTenantRepository(controlPlaneDb);
  void app.register(tenantRoutes(tenantRepository), { prefix: "/api/v1" });

  return app;
}
