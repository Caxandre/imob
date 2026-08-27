import { desc, eq, sql } from "drizzle-orm";

import { properties } from "../../../infrastructure/database/tenant/schema.js";
import type { TenantDatabase } from "../../tenant-runtime/application/tenant-database-connection-manager.js";
import type { Property } from "../domain/property.js";
import type {
  CreatePropertyInput,
  ListPropertiesInput,
  ListPropertiesResult,
  PropertyRepository,
} from "../application/property-repository.js";

function toProperty(row: typeof properties.$inferSelect): Property {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    propertyType: row.propertyType,
    transactionType: row.transactionType,
    status: row.status,
    price: row.price,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    parkingSpaces: row.parkingSpaces,
    areaM2: row.areaM2,
    street: row.street,
    number: row.number,
    complement: row.complement,
    neighborhood: row.neighborhood,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Real, Drizzle-backed `PropertyRepository`. Takes an already-scoped `TenantDatabase` — the
 * exact instance `TenantDatabaseConnectionManager.withTenantDatabase()` hands out for one
 * resolved tenant — never a `tenantId` or a way to pick which database to talk to; there is no
 * `tenant_id` column to filter by, because the database connection itself is already scoped
 * to one tenant (ADR-001).
 */
export function createDrizzlePropertyRepository(db: TenantDatabase): PropertyRepository {
  return {
    async create(input: CreatePropertyInput): Promise<Property> {
      const [row] = await db.insert(properties).values(input).returning();
      if (!row) {
        throw new Error("property insert returned no row");
      }
      return toProperty(row);
    },

    async list(input: ListPropertiesInput): Promise<ListPropertiesResult> {
      const offset = (input.page - 1) * input.limit;

      const [data, totalRows] = await Promise.all([
        db
          .select()
          .from(properties)
          .orderBy(desc(properties.createdAt), desc(properties.id))
          .limit(input.limit)
          .offset(offset),
        db.select({ count: sql<string>`count(*)` }).from(properties),
      ]);

      return { data: data.map(toProperty), total: Number(totalRows[0]?.count ?? 0) };
    },

    async findById(id: string): Promise<Property | undefined> {
      const [row] = await db.select().from(properties).where(eq(properties.id, id));
      return row ? toProperty(row) : undefined;
    },
  };
}
