import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { ControlPlaneDatabase } from "../../../infrastructure/database/control-plane/client.js";
import { provisioningJobs } from "../../../infrastructure/database/control-plane/schema.js";
import type {
  ClaimedProvisioningJob,
  ClaimEligibleJobsInput,
  ProvisioningDispatchRepository,
} from "../application/dispatch-provisioning-jobs.js";

export function createDrizzleProvisioningDispatchRepository(
  db: ControlPlaneDatabase,
): ProvisioningDispatchRepository {
  return {
    async claimEligibleJobs({
      batchSize,
      leaseSeconds,
    }: ClaimEligibleJobsInput): Promise<ClaimedProvisioningJob[]> {
      return db.transaction(async (tx) => {
        // FOR UPDATE SKIP LOCKED lets concurrent dispatcher instances each claim a
        // disjoint batch instead of colliding on the same rows (ADR-002, Protocol Step 1).
        const eligible = await tx
          .select({ id: provisioningJobs.id, tenantId: provisioningJobs.tenantId })
          .from(provisioningJobs)
          .where(
            and(
              eq(provisioningJobs.status, "PENDING"),
              isNull(provisioningJobs.dispatchedAt),
              or(
                isNull(provisioningJobs.dispatchLeaseUntil),
                sql`${provisioningJobs.dispatchLeaseUntil} <= now()`,
              ),
            ),
          )
          .orderBy(asc(provisioningJobs.createdAt), asc(provisioningJobs.id))
          .limit(batchSize)
          .for("update", { skipLocked: true });

        if (eligible.length === 0) {
          return [];
        }

        // now() (PostgreSQL) rather than the process clock — the lease is a database-level
        // concurrency mechanism, so its comparisons must use the database's own time.
        return tx
          .update(provisioningJobs)
          .set({
            dispatchClaimedAt: sql`now()`,
            dispatchLeaseUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
          })
          .where(
            inArray(
              provisioningJobs.id,
              eligible.map((row) => row.id),
            ),
          )
          .returning({ id: provisioningJobs.id, tenantId: provisioningJobs.tenantId });
      });
    },

    async markDispatched(jobId: string): Promise<void> {
      // Guarded by dispatchedAt IS NULL so a delayed/duplicate confirmation never
      // overwrites an already-confirmed dispatch (ADR-002, Protocol Step 4).
      await db
        .update(provisioningJobs)
        .set({ dispatchedAt: sql`now()`, dispatchLeaseUntil: null })
        .where(and(eq(provisioningJobs.id, jobId), isNull(provisioningJobs.dispatchedAt)));
    },

    async releaseLease(jobId: string): Promise<void> {
      // dispatchClaimedAt is deliberately left untouched — see ADR-002, Protocol Step 5.
      await db
        .update(provisioningJobs)
        .set({ dispatchLeaseUntil: null })
        .where(eq(provisioningJobs.id, jobId));
    },
  };
}
