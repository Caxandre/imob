import { z } from "zod";

/**
 * The shape every PostgreSQL credential in this module shares: something to log in as, and
 * something to authenticate with. Kept as one structural type because
 * `ClusterAdminCredential` and `TenantDatabaseCredential` are, today, genuinely the same
 * shape — a real hierarchy here would encode a distinction the data itself doesn't have.
 * The two are still never interchangeable in practice: they name different roles, come from
 * different `secretReference` namespaces, and are validated by separate Zod schemas below so
 * each can evolve independently the moment their shapes actually diverge (e.g. an added
 * `rotatedAt` on one but not the other).
 */
export interface DatabaseCredential {
  username: string;
  password: string;
}

/**
 * The cluster's administrative credential (`database_clusters.secret_reference`). Used only
 * by the platform to provision/administer infrastructure — never exposed to tenant
 * application code.
 */
export type ClusterAdminCredential = DatabaseCredential;

/**
 * A tenant's application role credential (`tenant-databases/<tenant-id>`). Used, in the
 * future, by the Connection Manager to open connections on the application's behalf — never
 * to perform administrative operations.
 */
export type TenantDatabaseCredential = DatabaseCredential;

/**
 * `.strict()`: an unexpected extra field on a credential payload is treated as a
 * configuration/integrity problem worth failing loudly on, not silently ignoring.
 */
export const clusterAdminCredentialSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

export const tenantDatabaseCredentialSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();
