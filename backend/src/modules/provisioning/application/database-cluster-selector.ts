/**
 * A PostgreSQL cluster tenant databases can be provisioned into. Never carries admin
 * credentials — only what a DatabaseProvisioner needs to know where to act and which
 * SecretStore entry names the administrative credential for that cluster.
 */
export interface DatabaseCluster {
  id: string;
  name: string;
  provider: string;
  region: string;
  secretReference: string;
}

/**
 * Raised when no ACTIVE cluster matches the configured selection target. Deliberately
 * generic: names the target that was searched for, never any credential or connection
 * detail.
 */
export class DatabaseClusterNotAvailableError extends Error {
  constructor(clusterName: string) {
    super(`No ACTIVE database cluster named "${clusterName}" is available`);
    this.name = "DatabaseClusterNotAvailableError";
  }
}

/**
 * Selects which cluster a tenant's database should be provisioned into (ADR-003).
 * tenantId is accepted for future cluster-assignment strategies (e.g. dedicated
 * infrastructure per tenant); the initial implementation ignores it and always resolves a
 * single configured default cluster. Never auto-selects "the first ACTIVE cluster" — an
 * unavailable target must fail loudly, not silently pick an arbitrary one.
 */
export interface DatabaseClusterSelector {
  selectClusterFor(tenantId: string): Promise<DatabaseCluster>;
}
