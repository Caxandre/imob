import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { controlPlaneDb } from "../infrastructure/database/control-plane/client.js";
import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { propertyRoutes } from "../modules/properties/http/property-routes.js";
import {
  createPropertyRequestSchema,
  propertyListSchema,
  propertySchema,
  updatePropertyRequestSchema,
} from "../modules/properties/http/property-openapi.schema.js";
import type { TenantDatabaseConnectionManager } from "../modules/tenant-runtime/application/tenant-database-connection-manager.js";
import { createDrizzleTenantDatabaseResolver } from "../modules/tenant-runtime/infrastructure/drizzle-tenant-database-resolver.js";
import { createDrizzleTenantRepository } from "../modules/tenants/infrastructure/drizzle-tenant-repository.js";
import { tenantRoutes } from "../modules/tenants/http/tenant-routes.js";
import { createTenantRequestSchema, tenantSchema } from "../modules/tenants/http/tenant-openapi.schema.js";
import { healthRoute } from "./routes/health.route.js";
import { errorResponseSchema } from "./schemas/error-response.schema.js";
import { healthResponseSchema } from "./schemas/health-response.schema.js";

export interface BuildAppDependencies {
  /**
   * Owned by the caller (`server.ts`/`dev-full.ts`/tests) — never constructed inside
   * `buildApp()` itself, since which `SecretStore` instance backs it (and, in particular,
   * whether it is shared with a separately-running provisioning worker process) is a runtime
   * composition decision, not something this function should make on its own. Closed via a
   * Fastify `onClose` hook below (this task, section 31/34): closing the app also closes every
   * pooled tenant connection this instance is holding.
   */
  tenantDatabaseConnectionManager: TenantDatabaseConnectionManager;
}

export function buildApp(deps: BuildAppDependencies): FastifyInstance {
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
        {
          name: "Properties",
          description:
            "Property listings, scoped to a single tenant's own database (Tenant Data " +
            "Plane). Every route requires the temporary X-Tenant-Id header — see its " +
            "description on each operation; this is development/integration scaffolding, " +
            "not authentication.",
        },
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
  app.addSchema(createPropertyRequestSchema);
  app.addSchema(updatePropertyRequestSchema);
  app.addSchema(propertySchema);
  app.addSchema(propertyListSchema);

  void app.register(healthRoute);

  const tenantRepository = createDrizzleTenantRepository(controlPlaneDb);
  void app.register(tenantRoutes(tenantRepository), { prefix: "/api/v1" });

  const tenantDatabaseResolver = createDrizzleTenantDatabaseResolver(controlPlaneDb);
  void app.register(
    propertyRoutes({
      tenantDatabaseResolver,
      tenantDatabaseConnectionManager: deps.tenantDatabaseConnectionManager,
    }),
    { prefix: "/api/v1" },
  );

  // Whoever created this app also created its TenantDatabaseConnectionManager — closing the
  // app is the one place that ownership can be discharged without every caller remembering to
  // do it separately (this task, section 31/34: never a singleton impossible to close).
  app.addHook("onClose", async () => {
    await deps.tenantDatabaseConnectionManager.close();
  });

  return app;
}
