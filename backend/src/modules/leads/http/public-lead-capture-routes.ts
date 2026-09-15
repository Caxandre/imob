import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { resolveTenantContext } from "../../../app/tenant-context.js";
import type { TenantDatabaseConnectionManager } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { TenantDatabaseResolver } from "../../tenant-runtime/application/tenant-database-resolver.js";
import { createDrizzlePropertyRepository } from "../../properties/infrastructure/drizzle-property-repository.js";
import { tenantIdHeaderSchema } from "../../properties/http/property-openapi.schema.js";
import { capturePropertyLead } from "../application/capture-property-lead.js";
import { createDrizzleLeadRepository } from "../infrastructure/drizzle-lead-repository.js";
import { mapLeadRouteError } from "./lead-error-mapper.js";
import {
  capturePropertyLeadBodySchema,
  capturePropertyLeadParamsSchema,
} from "./public-lead-capture-request.schema.js";

function badRequest(reply: FastifyReply, message: string, issues: { path: PropertyKey[]; message: string }[]) {
  return reply.status(400).send({
    statusCode: 400,
    error: "Bad Request",
    message,
    details: issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

/**
 * Same error-mapping wrapper convention as `lead-routes.ts` — `mapLeadRouteError` already
 * handles every error this handler can throw (`PublicPropertyNotFoundError` included), so this
 * route reuses it rather than a second, near-identical mapper.
 */
function withMappedErrors(handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      const mapped = mapLeadRouteError(error);
      if (mapped) {
        return reply.status(mapped.statusCode).send(mapped);
      }
      throw error;
    }
  };
}

export interface PublicLeadCaptureRoutesDependencies {
  tenantDatabaseResolver: TenantDatabaseResolver;
  tenantDatabaseConnectionManager: TenantDatabaseConnectionManager;
}

/**
 * Registers the public property lead-capture route (Prompt 045) — an unauthenticated,
 * visitor-facing counterpart to `lead-routes.ts`'s administrative `POST /leads`. Same fixed
 * pipeline: `TenantContext` (still the temporary `X-Tenant-Id` header, section 4 — this task
 * does not implement public tenant discovery by hostname/slug) → `TenantDatabaseResolver` →
 * `TenantDatabaseConnectionManager` → repositories scoped to that one tenant's database → the
 * `capturePropertyLead` use case. Synchronous end to end — no queue, no outbox (sections 60/61).
 */
export function publicLeadCaptureRoutes(deps: PublicLeadCaptureRoutesDependencies) {
  return async function register(app: FastifyInstance) {
    app.post(
      "/public/properties/:propertyId/leads",
      {
        // First-line abuse protection for this one public, unauthenticated route (Prompt 045,
        // sections 29-34) — deliberately NOT global (`build-app.ts` registers the plugin with
        // `global: false`, so no other route is affected). In-memory, per-Fastify-instance
        // counter (no `redis` option passed to the plugin): a real first barrier in
        // development/single-instance deployments, but explicitly NOT a distributed guarantee
        // across multiple server processes — see ARCHITECTURE.md. Keyed by the plugin's default
        // `request.ip`, which is only trustworthy because this server does not enable Fastify's
        // `trustProxy` option; deploying behind a real reverse proxy would require a conscious
        // `trustProxy` decision this task deliberately does not make (section 32).
        config: {
          rateLimit: { max: 5, timeWindow: "1 minute" },
        },
        schema: {
          operationId: "capturePropertyLead",
          summary: "Capture a public lead for a property",
          description:
            "Unauthenticated public lead capture endpoint. Tenant routing currently uses " +
            "X-Tenant-Id — this is temporary tenant routing context, not authentication and " +
            "not the final public tenant-discovery mechanism. Always creates a lead with " +
            'status NEW and source WEBSITE, bound to the property named in the URL. The ' +
            "property must be ACTIVE in this tenant's database — a missing or non-ACTIVE " +
            "property both respond 404, never revealing which.",
          tags: ["Public Leads"],
          headers: tenantIdHeaderSchema,
          params: {
            type: "object",
            properties: { propertyId: { type: "string", format: "uuid" } },
            required: ["propertyId"],
          },
          body: { $ref: "CapturePropertyLeadRequest#" },
          response: {
            201: { description: "Lead captured", $ref: "CapturePropertyLeadResponse#" },
            400: {
              description: "Invalid payload, missing contact channel, or missing/invalid X-Tenant-Id",
              $ref: "ErrorResponse#",
            },
            404: {
              description: "Property does not exist, or is not ACTIVE, in this tenant's database",
              $ref: "ErrorResponse#",
            },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            429: { description: "Too many requests from this client", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = capturePropertyLeadParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid property id", parsedParams.error.issues);
        }

        const parsedBody = capturePropertyLeadBodySchema.safeParse(request.body);
        if (!parsedBody.success) {
          return badRequest(reply, "Invalid request payload", parsedBody.error.issues);
        }

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const lead = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const leadRepository = createDrizzleLeadRepository(db);
          const propertyRepository = createDrizzlePropertyRepository(db);
          return capturePropertyLead(leadRepository, propertyRepository, parsedParams.data.propertyId, {
            name: parsedBody.data.name,
            email: parsedBody.data.email,
            phone: parsedBody.data.phone,
            message: parsedBody.data.message,
          });
        });

        // PII (name/email/phone/message) is never logged (Prompt 045, section 39) — only
        // identifiers and non-sensitive classification fields.
        request.log.info(
          {
            operation: "lead.publicCapture",
            tenantId: tenantContext.tenantId,
            leadId: lead.id,
            propertyId: lead.propertyId,
          },
          "public lead captured",
        );

        // Minimal response (Prompt 045, sections 24-26): never the full administrative Lead
        // shape — no status/source/notes/property metadata, and never an echo of the submitted
        // PII.
        return reply.status(201).send({ id: lead.id });
      }),
    );
  };
}
