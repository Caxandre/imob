import { InvalidTenantContextError, MissingTenantContextError } from "../../../app/tenant-context.js";
import { InvalidTenantSecretError } from "../../provisioning/application/tenant-role-provisioner.js";
import { TenantSecretNotFoundError } from "../../provisioning/application/tenant-database-credential-resolver.js";
import {
  TenantDatabaseNotAvailableError,
  TenantDatabaseRuntimeConfigurationError,
  TenantNotReadyError,
} from "../../tenant-runtime/application/tenant-database-resolver.js";
import { PropertyMediaNotFoundError, PropertyMediaReorderMismatchError } from "../domain/property-media.js";
import { PropertyArchivedError, PropertyNotFoundError } from "../domain/property.js";

export interface MappedHttpError {
  statusCode: number;
  error: string;
  message: string;
}

/**
 * Central place mapping every error a Properties route handler can encounter to an HTTP
 * response — so no handler needs its own `if (error instanceof ...)` chain (this task, section
 * 52). Returns `undefined` for anything it doesn't recognize; the caller must rethrow in that
 * case so the global error handler (`build-app.ts`) produces the generic controlled 500 —
 * this mapper never guesses a status for an error it doesn't know.
 */
export function mapPropertyRouteError(error: unknown): MappedHttpError | undefined {
  if (error instanceof MissingTenantContextError || error instanceof InvalidTenantContextError) {
    return { statusCode: 400, error: "Bad Request", message: error.message };
  }

  if (error instanceof PropertyNotFoundError) {
    return { statusCode: 404, error: "Not Found", message: error.message };
  }

  // Media that doesn't exist, or belongs to a different property/tenant — same 404 either way
  // (Prompt 028, section 18/28), for the same cross-tenant-enumeration reason as
  // `PropertyNotFoundError` above.
  if (error instanceof PropertyMediaNotFoundError) {
    return { statusCode: 404, error: "Not Found", message: error.message };
  }

  // `media_ids` doesn't exactly match the property's current gallery (Prompt 028, section
  // 17/20) — a state conflict, not a malformed request or a missing resource.
  if (error instanceof PropertyMediaReorderMismatchError) {
    return { statusCode: 409, error: "Conflict", message: error.message };
  }

  // Property media upload only (Prompt 027, section 42) — an archived property cannot accept
  // new media. The property itself is real and was found; this is a state conflict, not a
  // missing-resource 404.
  if (error instanceof PropertyArchivedError) {
    return { statusCode: 409, error: "Conflict", message: error.message };
  }

  // One uniform status for every reason the tenant itself is unusable right now — including
  // a tenant id that does not exist at all. X-Tenant-Id is not authentication (sections 6/53):
  // returning a different status for "doesn't exist" (which could imply 404) than for "exists
  // but SUSPENDED" would let an unauthenticated caller enumerate valid tenant ids purely from
  // the response code. 409 Conflict is used uniformly instead — the request cannot be
  // completed given the tenant's current state, without revealing which state that is.
  if (error instanceof TenantNotReadyError) {
    return { statusCode: 409, error: "Conflict", message: "Tenant is not ready to accept requests" };
  }

  // The tenant itself is READY, but its registered infrastructure is not reachable/usable
  // right now (missing/non-READY tenant_databases row, INACTIVE cluster, or a tenant secret
  // that could not be resolved/validated) — an operational problem, never something the
  // caller can fix by changing their request. No internal detail (which check failed, cluster
  // name, secret reference) is ever included in the message (section 6/51).
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
