import { InvalidTenantContextError, MissingTenantContextError } from "../../../app/tenant-context.js";
import { InvalidTenantSecretError } from "../../provisioning/application/tenant-role-provisioner.js";
import { TenantSecretNotFoundError } from "../../provisioning/application/tenant-database-credential-resolver.js";
import {
  TenantDatabaseNotAvailableError,
  TenantDatabaseRuntimeConfigurationError,
  TenantNotReadyError,
} from "../../tenant-runtime/application/tenant-database-resolver.js";
import { LeadContactChannelRequiredError, LeadNotFoundError, LeadPropertyNotFoundError } from "../domain/lead.js";

export interface MappedHttpError {
  statusCode: number;
  error: string;
  message: string;
}

/**
 * Central place mapping every error a Leads route handler can encounter to an HTTP response —
 * same convention as `mapPropertyRouteError`. Returns `undefined` for anything it doesn't
 * recognize; the caller must rethrow so the global error handler (`build-app.ts`) produces the
 * generic controlled 500 — this mapper never guesses a status for an error it doesn't know.
 */
export function mapLeadRouteError(error: unknown): MappedHttpError | undefined {
  if (error instanceof MissingTenantContextError || error instanceof InvalidTenantContextError) {
    return { statusCode: 400, error: "Bad Request", message: error.message };
  }

  if (error instanceof LeadNotFoundError) {
    return { statusCode: 404, error: "Not Found", message: error.message };
  }

  // `property_id` does not resolve to a property in this tenant's own database — the
  // association is the thing not found, not the lead itself (Prompt 043, section 27/64).
  if (error instanceof LeadPropertyNotFoundError) {
    return { statusCode: 404, error: "Not Found", message: error.message };
  }

  // The resulting state would leave the lead with neither email nor phone (Prompt 043, section
  // 48/49) — a malformed-request-shaped problem (400), not a resource conflict: the same
  // payload would succeed against a lead that still has another contact channel.
  if (error instanceof LeadContactChannelRequiredError) {
    return { statusCode: 400, error: "Bad Request", message: error.message };
  }

  // One uniform status for every reason the tenant itself is unusable right now — same
  // reasoning as `mapPropertyRouteError` (never lets a caller distinguish "doesn't exist" from
  // "exists but not READY" purely from the response code).
  if (error instanceof TenantNotReadyError) {
    return { statusCode: 409, error: "Conflict", message: "Tenant is not ready to accept requests" };
  }

  if (
    error instanceof TenantDatabaseNotAvailableError ||
    error instanceof TenantDatabaseRuntimeConfigurationError ||
    error instanceof TenantSecretNotFoundError ||
    error instanceof InvalidTenantSecretError
  ) {
    return {
      statusCode: 503,
      error: "Service Unavailable",
      message: "Tenant infrastructure is not currently available",
    };
  }

  return undefined;
}
