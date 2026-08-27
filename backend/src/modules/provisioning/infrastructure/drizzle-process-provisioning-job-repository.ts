import { and, eq, sql } from "drizzle-orm";

import type { ControlPlaneDatabase } from "../../../infrastructure/database/control-plane/client.js";
import {
  provisioningJobs,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import {
  InvalidProvisioningJobStateError,
  ProvisioningFinalizationConflictError,
  ProvisioningJobNotFoundError,
  ProvisioningJobTenantMismatchError,
  TenantProvisioningStateError,
} from "../application/process-provisioning-job.js";
import type {
  FinalizeProvisioningInput,
  ProcessProvisioningJobRepository,
  ProvisioningJobSnapshot,
} from "../application/process-provisioning-job.js";

const SNAPSHOT_COLUMNS = {
  id: provisioningJobs.id,
  tenantId: provisioningJobs.tenantId,
  status: provisioningJobs.status,
};

/** Set on `provisioning_jobs.current_step` once finalization commits — the workflow's terminal step. */
const FINALIZE_STEP = "FINALIZE";

export function createDrizzleProcessProvisioningJobRepository(
  db: ControlPlaneDatabase,
): ProcessProvisioningJobRepository {
  return {
    async findById(id: string): Promise<ProvisioningJobSnapshot | undefined> {
      const [row] = await db
        .select(SNAPSHOT_COLUMNS)
        .from(provisioningJobs)
        .where(eq(provisioningJobs.id, id));

      return row;
    },

    async markRunning(id: string, currentStep: string): Promise<ProvisioningJobSnapshot | undefined> {
      // The WHERE clause is the concurrency guard, not just a filter (this task, section
      // 16): only a row that is still PENDING at write time gets updated, so two concurrent
      // deliveries of the same job can never both transition it to RUNNING.
      const [row] = await db
        .update(provisioningJobs)
        .set({
          status: "RUNNING",
          attempts: sql`${provisioningJobs.attempts} + 1`,
          startedAt: sql`now()`,
          currentStep,
        })
        .where(and(eq(provisioningJobs.id, id), eq(provisioningJobs.status, "PENDING")))
        .returning(SNAPSHOT_COLUMNS);

      return row;
    },

    /**
     * Single PostgreSQL transaction (ADR-003 "Finalization"): reconciles/creates
     * `tenant_databases`, activates the tenant, and marks the job SUCCEEDED — atomically, or
     * not at all. `FOR UPDATE` on both the job row and the tenant row is the concurrency
     * guard: two concurrent finalizations for the same job/tenant serialize on these locks
     * (the second blocks until the first commits, then re-reads the now-finalized rows and
     * takes the idempotent path below) rather than racing on the `tenant_databases` unique
     * constraint.
     */
    async finalizeProvisioning(input: FinalizeProvisioningInput): Promise<void> {
      const { provisioningJobId, tenantId, result } = input;

      await db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(provisioningJobs)
          .where(eq(provisioningJobs.id, provisioningJobId))
          .for("update");

        if (!job) {
          throw new ProvisioningJobNotFoundError(provisioningJobId);
        }
        if (job.tenantId !== tenantId) {
          throw new ProvisioningJobTenantMismatchError(provisioningJobId, job.tenantId, tenantId);
        }
        if (job.type !== "CREATE_DATABASE") {
          throw new InvalidProvisioningJobStateError(
            provisioningJobId,
            `unexpected job type "${job.type}", expected "CREATE_DATABASE"`,
          );
        }

        // SUCCEEDED is only valid here as an idempotent retry (e.g. the caller committed
        // this same finalization before, then crashed before observing success) — compatibility
        // with `result` is verified below via the tenant_databases comparison, never assumed
        // from the status alone.
        const jobAlreadySucceeded = job.status === "SUCCEEDED";
        if (job.status !== "RUNNING" && !jobAlreadySucceeded) {
          throw new InvalidProvisioningJobStateError(
            provisioningJobId,
            `status is "${job.status}", expected "RUNNING"`,
          );
        }

        const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update");

        if (!tenant) {
          // Not reachable in practice: provisioning_jobs.tenant_id has a NOT NULL FK to
          // tenants with ON DELETE RESTRICT, so a job can never outlive its tenant.
          throw new Error(
            `Tenant "${tenantId}" referenced by provisioning job "${provisioningJobId}" was not found`,
          );
        }

        const tenantAlreadyReady = tenant.status === "READY";
        if (tenant.status !== "PROVISIONING" && !tenantAlreadyReady) {
          throw new TenantProvisioningStateError(tenantId, tenant.status);
        }

        const [existingTenantDatabase] = await tx
          .select()
          .from(tenantDatabases)
          .where(eq(tenantDatabases.tenantId, tenantId));

        if (existingTenantDatabase) {
          const compatible =
            existingTenantDatabase.clusterId === result.clusterId &&
            existingTenantDatabase.databaseName === result.databaseName &&
            existingTenantDatabase.secretReference === result.secretReference &&
            existingTenantDatabase.schemaVersion === result.schemaVersion;

          if (!compatible) {
            throw new ProvisioningFinalizationConflictError(tenantId);
          }
        } else {
          // Never inserted as PROVISIONING first (ADR-003): by this point every external
          // effect — role, database, migrations, permissions, health check — already
          // succeeded, so the record is READY from the moment it exists.
          await tx.insert(tenantDatabases).values({
            tenantId,
            clusterId: result.clusterId,
            databaseName: result.databaseName,
            secretReference: result.secretReference,
            schemaVersion: result.schemaVersion,
            status: "READY",
          });
        }

        if (!tenantAlreadyReady) {
          await tx
            .update(tenants)
            .set({ status: "READY", updatedAt: sql`now()` })
            .where(eq(tenants.id, tenantId));
        }

        if (!jobAlreadySucceeded) {
          await tx
            .update(provisioningJobs)
            .set({
              status: "SUCCEEDED",
              finishedAt: sql`now()`,
              errorMessage: null,
              currentStep: FINALIZE_STEP,
              updatedAt: sql`now()`,
            })
            .where(eq(provisioningJobs.id, provisioningJobId));
        }
      });
    },

    async markFailed(id: string, errorMessage: string): Promise<void> {
      await db
        .update(provisioningJobs)
        .set({ status: "FAILED", finishedAt: sql`now()`, errorMessage })
        .where(and(eq(provisioningJobs.id, id), eq(provisioningJobs.status, "RUNNING")));
    },
  };
}
