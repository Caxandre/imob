import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { resolveTenantContext } from "../../../app/tenant-context.js";
import type { TenantDatabaseConnectionManager } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { TenantDatabaseResolver } from "../../tenant-runtime/application/tenant-database-resolver.js";
import { createDrizzlePropertyRepository } from "../../properties/infrastructure/drizzle-property-repository.js";
import { tenantIdHeaderSchema } from "../../properties/http/property-openapi.schema.js";
import { createLead } from "../application/create-lead.js";
import { getLead } from "../application/get-lead.js";
import type { LeadListFilters, LeadSort, ListLeadsInput, SortOrder, UpdateLeadInput } from "../application/lead-repository.js";
import { listLeads } from "../application/list-leads.js";
import { updateLead } from "../application/update-lead.js";
import type { Lead } from "../domain/lead.js";
import type { LeadWithPropertySummary } from "../domain/lead-property-summary.js";
import { createDrizzleLeadRepository } from "../infrastructure/drizzle-lead-repository.js";
import { mapLeadRouteError } from "./lead-error-mapper.js";
import { createLeadBodySchema, leadIdParamsSchema, listLeadsQuerySchema, updateLeadBodySchema } from "./lead-request.schema.js";

function toLeadResponse(lead: Lead) {
  return {
    id: lead.id,
    property_id: lead.propertyId,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    status: lead.status,
    source: lead.source,
    message: lead.message,
    notes: lead.notes,
    created_at: lead.createdAt.toISOString(),
    updated_at: lead.updatedAt.toISOString(),
  };
}

/** `GET /api/v1/leads` and `GET /api/v1/leads/:id` only (Prompt 043, section 42/46) — adds the
 * summarized `property` on top of `toLeadResponse`'s own fields. Never used for create/update
 * responses, which never carry `property`. */
function toLeadWithPropertyResponse(lead: LeadWithPropertySummary) {
  return { ...toLeadResponse(lead), property: lead.property };
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
 * Wraps a handler so every Leads route shares the exact same error → HTTP mapping, instead of
 * repeating a try/catch per handler — same convention as Properties' `withMappedErrors`.
 */
function withMappedErrors(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
) {
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

export interface LeadRoutesDependencies {
  tenantDatabaseResolver: TenantDatabaseResolver;
  tenantDatabaseConnectionManager: TenantDatabaseConnectionManager;
}

/**
 * Registers the Leads HTTP routes (Prompt 043) — same fixed path as Properties: request →
 * `TenantContext` → `TenantDatabaseResolver` → `TenantDatabaseConnectionManager` → repositories
 * scoped to that one tenant's database → the use case. This module is synchronous end to end —
 * no Redis/BullMQ, no outbox event, no queue (section 57/79).
 */
export function leadRoutes(deps: LeadRoutesDependencies) {
  return async function register(app: FastifyInstance) {
    app.post(
      "/leads",
      {
        schema: {
          operationId: "createLead",
          summary: "Create lead",
          description:
            "Creates a lead in the tenant's own database (Tenant Data Plane). Always created " +
            "with status NEW — a client can never choose the initial status. At least one of " +
            '"email"/"phone" is required. X-Tenant-Id is a temporary development mechanism — ' +
            "see the header description.",
          tags: ["Leads"],
          headers: tenantIdHeaderSchema,
          body: { $ref: "CreateLeadRequest#" },
          response: {
            201: { description: "Lead created", $ref: "Lead#" },
            400: {
              description: "Invalid payload, missing contact channel, or missing/invalid X-Tenant-Id",
              $ref: "ErrorResponse#",
            },
            404: { description: "property_id does not resolve to a property in this tenant", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsed = createLeadBodySchema.safeParse(request.body);
        if (!parsed.success) {
          return badRequest(reply, "Invalid request payload", parsed.error.issues);
        }

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const lead = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const leadRepository = createDrizzleLeadRepository(db);
          const propertyRepository = createDrizzlePropertyRepository(db);
          return createLead(leadRepository, propertyRepository, {
            propertyId: parsed.data.property_id,
            name: parsed.data.name,
            email: parsed.data.email,
            phone: parsed.data.phone,
            source: parsed.data.source,
            message: parsed.data.message,
            notes: parsed.data.notes,
          });
        });

        // PII (name/email/phone/message/notes) is never logged (Prompt 043, section 54) — only
        // identifiers and non-sensitive classification fields.
        request.log.info(
          { operation: "lead.create", tenantId: tenantContext.tenantId, leadId: lead.id, source: lead.source },
          "lead created",
        );

        return reply.status(201).send(toLeadResponse(lead));
      }),
    );

    app.get(
      "/leads",
      {
        schema: {
          operationId: "listLeads",
          summary: "List leads",
          description:
            "Lists leads in the tenant's own database, with optional structured filters " +
            "(AND-combined) and sorting. Each item includes a summarized property association " +
            "(id/title/status) when one exists, loaded via a single JOIN — never a request per " +
            "lead. Unknown query parameters are rejected with 400.",
          tags: ["Leads"],
          headers: tenantIdHeaderSchema,
          querystring: {
            type: "object",
            properties: {
              page: { type: "integer", minimum: 1, description: "Defaults to 1." },
              limit: { type: "integer", minimum: 1, maximum: 100, description: "Defaults to 20, capped at 100." },
              status: { type: "string", enum: ["NEW", "CONTACTED", "QUALIFIED", "WON", "LOST"] },
              source: { type: "string", enum: ["MANUAL", "WEBSITE", "WHATSAPP", "PORTAL", "OTHER"] },
              property_id: { type: "string", format: "uuid" },
              created_from: { type: "string", format: "date-time", description: "Inclusive lower bound." },
              created_to: { type: "string", format: "date-time", description: "Inclusive upper bound." },
              q: {
                type: "string",
                description: "Case-insensitive substring match over name/email/phone (ILIKE, not full-text search).",
              },
              sort: {
                type: "string",
                enum: ["created_at", "updated_at", "name", "status"],
                description: "Defaults to created_at.",
              },
              order: { type: "string", enum: ["asc", "desc"], description: "Defaults to desc." },
            },
            examples: [
              { status: "NEW" },
              { q: "maria" },
              { property_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
              { sort: "name", order: "asc" },
            ],
          },
          response: {
            200: { description: "Paginated list of leads", $ref: "LeadList#" },
            400: { description: "Invalid query parameters or missing/invalid X-Tenant-Id", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedQuery = listLeadsQuerySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          return badRequest(reply, "Invalid query parameters", parsedQuery.error.issues);
        }

        const query = parsedQuery.data;
        const filters: LeadListFilters = {
          status: query.status,
          source: query.source,
          propertyId: query.property_id,
          createdFrom: query.created_from !== undefined ? new Date(query.created_from) : undefined,
          createdTo: query.created_to !== undefined ? new Date(query.created_to) : undefined,
          query: query.q,
        };
        const sort: LeadSort = query.sort;
        const order: SortOrder = query.order;
        const listInput: ListLeadsInput = { page: query.page, limit: query.limit, filters, sort, order };

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const result = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const repository = createDrizzleLeadRepository(db);
          return listLeads(repository, listInput);
        });

        return reply.send({
          data: result.data.map(toLeadWithPropertyResponse),
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
      "/leads/:id",
      {
        schema: {
          operationId: "getLead",
          summary: "Get lead by id",
          tags: ["Leads"],
          headers: tenantIdHeaderSchema,
          params: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
          },
          response: {
            200: { description: "Lead found", $ref: "LeadWithProperty#" },
            400: { description: "Invalid id or missing/invalid X-Tenant-Id", $ref: "ErrorResponse#" },
            404: { description: "Lead not found", $ref: "ErrorResponse#" },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = leadIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid lead id", parsedParams.error.issues);
        }

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const lead = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const repository = createDrizzleLeadRepository(db);
          return getLead(repository, parsedParams.data.id);
        });

        return reply.send(toLeadWithPropertyResponse(lead));
      }),
    );

    app.patch(
      "/leads/:id",
      {
        schema: {
          operationId: "updateLead",
          summary: "Update lead",
          description:
            "Partially updates a lead in the tenant's own database. Any subset of the " +
            "editable fields may be sent; fields omitted from the body are left unchanged. " +
            "The resulting lead must still retain at least one contact channel (email or " +
            "phone) — a PATCH that would clear the only remaining one is rejected with 400, " +
            "even if the field being cleared is itself well-formed. id/created_at/updated_at " +
            "are immutable and rejected if present in the body.",
          tags: ["Leads"],
          headers: tenantIdHeaderSchema,
          params: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
          },
          body: { $ref: "UpdateLeadRequest#" },
          response: {
            200: { description: "Lead updated", $ref: "Lead#" },
            400: {
              description:
                "Invalid payload, empty body, missing/invalid X-Tenant-Id, or the update would " +
                "leave the lead with no contact channel",
              $ref: "ErrorResponse#",
            },
            404: {
              description: "Lead not found, or property_id does not resolve to a property in this tenant",
              $ref: "ErrorResponse#",
            },
            409: { description: "Tenant is not READY", $ref: "ErrorResponse#" },
            503: { description: "Tenant infrastructure is not currently available", $ref: "ErrorResponse#" },
            500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
          },
        },
      },
      withMappedErrors(async (request, reply) => {
        const tenantContext = resolveTenantContext(request);

        const parsedParams = leadIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return badRequest(reply, "Invalid lead id", parsedParams.error.issues);
        }

        const parsedBody = updateLeadBodySchema.safeParse(request.body);
        if (!parsedBody.success) {
          return badRequest(reply, "Invalid request payload", parsedBody.error.issues);
        }

        // Only keys actually present in the parsed body are copied — an omitted key must never
        // be confused with an explicit `null` (same discipline as Properties' own PATCH
        // handler).
        const input: UpdateLeadInput = {};
        const body = parsedBody.data;
        if ("name" in body) input.name = body.name;
        if ("email" in body) input.email = body.email;
        if ("phone" in body) input.phone = body.phone;
        if ("property_id" in body) input.propertyId = body.property_id;
        if ("status" in body) input.status = body.status;
        if ("source" in body) input.source = body.source;
        if ("message" in body) input.message = body.message;
        if ("notes" in body) input.notes = body.notes;

        const target = await deps.tenantDatabaseResolver.resolve(tenantContext.tenantId);
        const lead = await deps.tenantDatabaseConnectionManager.withTenantDatabase(target, async (db) => {
          const leadRepository = createDrizzleLeadRepository(db);
          const propertyRepository = createDrizzlePropertyRepository(db);
          return updateLead(leadRepository, propertyRepository, parsedParams.data.id, input);
        });

        request.log.info(
          { operation: "lead.update", tenantId: tenantContext.tenantId, leadId: lead.id, status: lead.status },
          "lead updated",
        );

        return reply.send(toLeadResponse(lead));
      }),
    );
  };
}
