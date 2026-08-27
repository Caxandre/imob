/**
 * The outcome of a completed, verified external provisioning attempt (ADR-003): a cluster
 * was selected, the tenant's role/database/migrations/health check all succeeded, and this
 * is everything the application layer needs to finalize the workflow in the Control Plane.
 *
 * Deliberately excludes anything that must never leave the provisioner: no password, no
 * host, no connection string, no admin credential. `secretReference` is a pointer into a
 * SecretStore, never the secret value itself.
 *
 * `DatabaseProvisioner.provision()` returns this (see process-provisioning-job.ts); the
 * Control Plane finalization (`ProcessProvisioningJobRepository.finalizeProvisioning()`,
 * Prompt 018) persists it into `tenant_databases`.
 */
export interface ProvisioningResult {
  clusterId: string;
  databaseName: string;
  secretReference: string;
  schemaVersion: number;
}
