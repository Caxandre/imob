import { and, eq, sql } from "drizzle-orm";

import type { ControlPlaneDatabase } from "../../../infrastructure/database/control-plane/client.js";
import { provisioningJobs } from "../../../infrastructure/database/control-plane/schema.js";
import type {
  ProcessProvisioningJobRepository,
  ProvisioningJobSnapshot,
} from "../application/process-provisioning-job.js";

const SNAPSHOT_COLUMNS = {
  id: provisioningJobs.id,
  tenantId: provisioningJobs.tenantId,
  status: provisioningJobs.status,
};

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

    async markSucceeded(id: string): Promise<void> {
      await db
        .update(provisioningJobs)
        .set({ status: "SUCCEEDED", finishedAt: sql`now()`, errorMessage: null })
        .where(and(eq(provisioningJobs.id, id), eq(provisioningJobs.status, "RUNNING")));
    },

    async markFailed(id: string, errorMessage: string): Promise<void> {
      await db
        .update(provisioningJobs)
        .set({ status: "FAILED", finishedAt: sql`now()`, errorMessage })
        .where(and(eq(provisioningJobs.id, id), eq(provisioningJobs.status, "RUNNING")));
    },
  };
}
