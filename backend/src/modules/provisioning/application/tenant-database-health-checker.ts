import type { DatabaseCluster } from "./database-cluster-selector.js";
import type { TenantDatabaseCredential } from "./database-credential.js";

/**
 * Proves the tenant's database is actually usable *by the application* — not just that it
 * exists. Always authenticates with the tenant application credential, never the
 * administrative one: a health check that connects as admin would only prove the database
 * exists, not that the tenant role/password/CONNECT grant/schema privileges the application
 * actually depends on are all consistent with each other (ADR-003).
 */
export interface TenantDatabaseHealthChecker {
  check(input: {
    cluster: DatabaseCluster;
    databaseName: string;
    credential: TenantDatabaseCredential;
    expectedSchemaVersion: number;
  }): Promise<void>;
}

/**
 * Raised when any health check condition fails — authentication, wrong database, the `SELECT
 * 1` probe, or a schema version mismatch. Fail-closed: a thrown error means the caller must
 * never treat provisioning as complete. Never includes the credential in the message; the
 * original error (if any) is preserved only on `.cause`, for structured logging.
 */
export class TenantDatabaseHealthCheckError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "TenantDatabaseHealthCheckError";
  }
}
