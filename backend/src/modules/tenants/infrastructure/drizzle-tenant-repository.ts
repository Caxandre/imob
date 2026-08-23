import type { CreateTenantInput, TenantRepository } from "../application/create-tenant.js";
import type { Tenant } from "../domain/tenant.js";
import { TenantSlugAlreadyExistsError } from "../domain/tenant.js";
import type { ControlPlaneDatabase } from "../../../infrastructure/database/control-plane/client.js";
import {
  provisioningJobs,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import { isUniqueViolation } from "../../../infrastructure/database/postgres-errors.js";

const SLUG_UNIQUE_CONSTRAINT = "tenants_slug_unique";

export function createDrizzleTenantRepository(db: ControlPlaneDatabase): TenantRepository {
  return {
    async createWithProvisioningIntent(input: CreateTenantInput): Promise<Tenant> {
      try {
        return await db.transaction(async (tx) => {
          // id, status and timestamps come from the database defaults.
          const [tenant] = await tx
            .insert(tenants)
            .values({ name: input.name, slug: input.slug })
            .returning();

          if (!tenant) {
            throw new Error("Tenant insert returned no row");
          }

          // status, attempts and the remaining nullable columns come from the database
          // defaults — recording the row is the entire "provisioning intent" at this stage.
          await tx.insert(provisioningJobs).values({
            tenantId: tenant.id,
            type: "CREATE_DATABASE",
          });

          return tenant;
        });
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
