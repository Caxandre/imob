export type TenantStatus = "PROVISIONING" | "READY" | "FAILED" | "SUSPENDED";

/**
 * Tenant as the application layer sees it. Kept free of Drizzle/PostgreSQL types so business
 * code does not depend on how (or where) the Control Plane stores it.
 */
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Raised when a tenant with the same slug already exists. Maps to HTTP 409 at the edge. */
export class TenantSlugAlreadyExistsError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`A tenant with slug "${slug}" already exists`);
    this.name = "TenantSlugAlreadyExistsError";
    this.slug = slug;
  }
}
