import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { ControlPlaneDatabase } from "../../../infrastructure/database/control-plane/client.js";
import {
  provisioningJobs,
  tenantDatabases,
  tenants,
} from "../../../infrastructure/database/control-plane/schema.js";
import {
  InvalidProvisioningJobStateError,
  ProvisioningExecutionOwnershipLostError,
  ProvisioningFinalizationConflictError,
  ProvisioningJobNotFoundError,
  ProvisioningJobTenantMismatchError,
  TenantProvisioningStateError,
} from "../application/process-provisioning-job.js";
import type {
  ExecutionClaim,
  FinalizeProvisioningInput,
  ProcessProvisioningJobRepository,
  ProvisioningJobSnapshot,
} from "../application/process-provisioning-job.js";

const SNAPSHOT_COLUMNS = {
  id: provisioningJobs.id,
  tenantId: provisioningJobs.tenantId,
  status: provisioningJobs.status,
};

const CLAIM_COLUMNS = {
  id: provisioningJobs.id,
  tenantId: provisioningJobs.tenantId,
  executionToken: provisioningJobs.executionToken,
};

/** Set on `provisioning_jobs.current_step` once finalization commits — the workflow's terminal step. */
const FINALIZE_STEP = "FINALIZE";

function toExecutionClaim(row: { id: string; tenantId: string; executionToken: string | null }): ExecutionClaim {
  if (!row.executionToken) {
    // Unreachable: every write that produces one of these rows sets executionToken in the
    // same statement (gen_random_uuid()), so a NULL here would mean the SQL itself is wrong.
    throw new Error(`Provisioning job "${row.id}" claim is missing its execution token`);
  }
  return { id: row.id, tenantId: row.tenantId, executionToken: row.executionToken };
}

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

    async markRunning(id: string, currentStep: string, leaseSeconds: number): Promise<ExecutionClaim | undefined> {
      // The WHERE clause is the concurrency guard, not just a filter: only a row that is
      // still PENDING at write time gets updated, so two concurrent deliveries of the same
      // job can never both transition it to RUNNING. The execution lease (token/heartbeat/
      // lease-until) is granted in this same atomic write — never a separate follow-up
      // statement (ADR-003 "Recovery").
      const [row] = await db
        .update(provisioningJobs)
        .set({
          status: "RUNNING",
          attempts: sql`${provisioningJobs.attempts} + 1`,
          startedAt: sql`now()`,
          currentStep,
          executionToken: sql`gen_random_uuid()`,
          executionHeartbeatAt: sql`now()`,
          executionLeaseUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
        })
        .where(and(eq(provisioningJobs.id, id), eq(provisioningJobs.status, "PENDING")))
        .returning(CLAIM_COLUMNS);

      return row ? toExecutionClaim(row) : undefined;
    },

    async claimExpiredRunningJobs(input: { batchSize: number; leaseSeconds: number }): Promise<ExecutionClaim[]> {
      const rows = await db.transaction(async (tx) => {
        // FOR UPDATE SKIP LOCKED lets concurrent recovery instances each claim a disjoint
        // batch instead of colliding on the same rows — same technique already proven for
        // the dispatcher (ADR-002, Protocol Step 1). A NULL execution_lease_until is also
        // eligible: a job left RUNNING from before this mechanism existed has no lease to
        // compare against, and must not be permanently unrecoverable because of that.
        const eligible = await tx
          .select({ id: provisioningJobs.id })
          .from(provisioningJobs)
          .where(
            and(
              eq(provisioningJobs.status, "RUNNING"),
              or(isNull(provisioningJobs.executionLeaseUntil), sql`${provisioningJobs.executionLeaseUntil} <= now()`),
            ),
          )
          .orderBy(asc(provisioningJobs.executionLeaseUntil), asc(provisioningJobs.createdAt), asc(provisioningJobs.id))
          .limit(input.batchSize)
          .for("update", { skipLocked: true });

        if (eligible.length === 0) {
          return [];
        }

        // Reclaiming is a real new execution attempt (this task, section 11) — attempts is
        // incremented exactly as the original PENDING → RUNNING transition already does.
        // Status stays RUNNING: this is not a redispatch through the dispatcher/BullMQ, and
        // none of dispatchClaimedAt/dispatchLeaseUntil/dispatchedAt are touched.
        return tx
          .update(provisioningJobs)
          .set({
            attempts: sql`${provisioningJobs.attempts} + 1`,
            executionToken: sql`gen_random_uuid()`,
            executionHeartbeatAt: sql`now()`,
            executionLeaseUntil: sql`now() + make_interval(secs => ${input.leaseSeconds})`,
          })
          .where(
            inArray(
              provisioningJobs.id,
              eligible.map((row) => row.id),
            ),
          )
          .returning(CLAIM_COLUMNS);
      });

      return rows.map(toExecutionClaim);
    },

    async renewExecutionLease(id: string, executionToken: string, leaseSeconds: number): Promise<boolean> {
      const result = await db
        .update(provisioningJobs)
        .set({
          executionHeartbeatAt: sql`now()`,
          executionLeaseUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
        })
        .where(
          and(
            eq(provisioningJobs.id, id),
            eq(provisioningJobs.status, "RUNNING"),
            eq(provisioningJobs.executionToken, executionToken),
          ),
        )
        .returning({ id: provisioningJobs.id });

      return result.length > 0;
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
      const { provisioningJobId, tenantId, executionToken, result } = input;

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

        // Ownership only matters while still RUNNING — a SUCCEEDED row may already have had
        // its token cleared by the very commit this call is idempotently re-confirming
        // (this task, section 25).
        if (!jobAlreadySucceeded && job.executionToken !== executionToken) {
          throw new ProvisioningExecutionOwnershipLostError(provisioningJobId);
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
          // executionToken/executionLeaseUntil are cleared on this terminal transition —
          // executionHeartbeatAt deliberately survives as the record of last real activity
          // (this task, section 21).
          await tx
            .update(provisioningJobs)
            .set({
              status: "SUCCEEDED",
              finishedAt: sql`now()`,
              errorMessage: null,
              currentStep: FINALIZE_STEP,
              executionToken: null,
              executionLeaseUntil: null,
              updatedAt: sql`now()`,
            })
            .where(eq(provisioningJobs.id, provisioningJobId));
        }
      });
    },

    async markFailed(id: string, executionToken: string, errorMessage: string): Promise<void> {
      const [updated] = await db
        .update(provisioningJobs)
        .set({
          status: "FAILED",
          finishedAt: sql`now()`,
          errorMessage,
          executionToken: null,
          executionLeaseUntil: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(provisioningJobs.id, id),
            eq(provisioningJobs.status, "RUNNING"),
            eq(provisioningJobs.executionToken, executionToken),
          ),
        )
        .returning({ id: provisioningJobs.id });

      if (updated) {
        return;
      }

      // 0 rows affected — find out why, without assuming: still RUNNING but owned by a
      // different execution now (ownership lost — throw) vs. already a terminal/non-RUNNING
      // state (silent no-op, preserving the pre-existing "not RUNNING" guard behavior).
      const [current] = await db
        .select({ status: provisioningJobs.status })
        .from(provisioningJobs)
        .where(eq(provisioningJobs.id, id));

      if (current?.status === "RUNNING") {
        throw new ProvisioningExecutionOwnershipLostError(id);
      }
    },
  };
}
