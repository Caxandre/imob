import type { CreateTenantInput, TenantRepository } from "../application/create-tenant.js";
import type { Tenant } from "../domain/tenant.js";
import { TenantSlugAlreadyExistsError } from "../domain/tenant.js";
import type { ControlPlaneDatabase } from "../../../infrastructure/database/control-plane/client.js";
import { tenants } from "../../../infrastructure/database/control-plane/schema.js";
import { isUniqueViolation } from "../../../infrastructure/database/postgres-errors.js";

const SLUG_UNIQUE_CONSTRAINT = "tenants_slug_unique";

export function createDrizzleTenantRepository(db: ControlPlaneDatabase): TenantRepository {
  return {
    async create(input: CreateTenantInput): Promise<Tenant> {
      try {
        // id, status and timestamps come from the database defaults.
        const [row] = await db
          .insert(tenants)
          .values({ name: input.name, slug: input.slug })
          .returning();

        if (!row) {
          throw new Error("Tenant insert returned no row");
        }

        return row;
      } catch (error) {
        // The UNIQUE constraint is the authoritative guard against concurrent inserts.
        if (isUniqueViolation(error, SLUG_UNIQUE_CONSTRAINT)) {
          throw new TenantSlugAlreadyExistsError(input.slug);
        }

        throw error;
      }
    },
  };
}
