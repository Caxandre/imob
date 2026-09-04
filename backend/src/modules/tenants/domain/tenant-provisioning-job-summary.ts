/**
 * Mirrors `provisioning_job_type`/`provisioning_job_status` in
 * `infrastructure/database/control-plane/schema.ts` manually — the same domain/schema
 * duplication already used for `TenantDatabaseStatus`/`DatabaseClusterStatus`. Also mirrors
 * `ProvisioningJobStatus` in `modules/provisioning/application/process-provisioning-job.ts`
 * (a genuinely identical value set defined independently, not imported — the Tenants module's
 * domain layer stays free of a dependency on the Provisioning module's application layer for a
 * single enum-shaped value).
 */
export type ProvisioningJobType = "CREATE_DATABASE";
export type ProvisioningJobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

/**
 * Summary of a tenant's most recent provisioning job, as surfaced by the tenant details
 * endpoint (Prompt 034). Deliberately excludes every internal dispatch/execution-lease field
 * (`dispatch_claimed_at`, `dispatch_lease_until`, `execution_token`,
 * `execution_heartbeat_at`, `execution_lease_until`, `attempts`, `current_step`) — this is an
 * administrative summary, never a dump of the row (this task, section 14). `errorMessage` is
 * included because the schema already models it as a short, safe failure summary (never a
 * stack trace or raw SQL error — see `provisioning_jobs.error_message` in
 * `infrastructure/database/control-plane/schema.ts`), and it is directly useful for
 * understanding *why* a job is `FAILED` without a manual SQL query (this task, section 5/15).
 */
export interface ProvisioningJobSummary {
  id: string;
  type: ProvisioningJobType;
  status: ProvisioningJobStatus;
  createdAt: Date;
  updatedAt: Date;
  dispatchedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
}
