import { describe, expect, it } from "vitest";

import { createTenant, type CreateTenantInput, type TenantRepository } from "./create-tenant.js";
import { TenantSlugAlreadyExistsError, type Tenant } from "../domain/tenant.js";

function fakeRepository(overrides: Partial<TenantRepository> = {}): TenantRepository {
  return {
    createWithProvisioningIntent: async (input: CreateTenantInput): Promise<Tenant> => ({
      id: "11111111-1111-4111-8111-111111111111",
      name: input.name,
      slug: input.slug,
      status: "PROVISIONING",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
    ...overrides,
  };
}

describe("createTenant", () => {
  it("returns the persisted tenant", async () => {
    const tenant = await createTenant(fakeRepository(), {
      name: "Imobiliária Exemplo",
      slug: "imobiliaria-exemplo",
    });

    expect(tenant).toMatchObject({
      name: "Imobiliária Exemplo",
      slug: "imobiliaria-exemplo",
      status: "PROVISIONING",
    });
  });

  it("passes the input through to the repository unchanged", async () => {
    const received: CreateTenantInput[] = [];
    const repository = fakeRepository({
      createWithProvisioningIntent: async (input) => {
        received.push(input);
        return fakeRepository().createWithProvisioningIntent(input);
      },
    });

    await createTenant(repository, { name: "Acme", slug: "acme" });

    expect(received).toEqual([{ name: "Acme", slug: "acme" }]);
  });

  it("propagates a duplicate slug error from the repository", async () => {
    const repository = fakeRepository({
      createWithProvisioningIntent: async (input) => {
        throw new TenantSlugAlreadyExistsError(input.slug);
      },
    });

    await expect(createTenant(repository, { name: "Acme", slug: "acme" })).rejects.toThrow(
      TenantSlugAlreadyExistsError,
    );
  });
});
