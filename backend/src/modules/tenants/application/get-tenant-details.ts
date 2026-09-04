import { TenantNotFoundError, type TenantDetails } from "../domain/tenant.js";
import type { TenantRepository } from "./tenant-repository.js";

/**
 * Fetches one tenant's administrative details from the Control Plane. Throws
 * {@link TenantNotFoundError} when no tenant with that id exists — the HTTP boundary maps this
 * to 404 (this task, section 23), never a `200` with a `null` body.
 */
export async function getTenantDetails(repository: TenantRepository, id: string): Promise<TenantDetails> {
  const details = await repository.findDetailsById(id);

  if (!details) {
    throw new TenantNotFoundError(id);
  }

  return details;
}
