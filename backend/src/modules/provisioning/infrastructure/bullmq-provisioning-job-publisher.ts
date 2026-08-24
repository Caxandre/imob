import {
  PROVISION_TENANT_JOB_NAME,
  type TenantProvisioningQueue,
} from "../../../infrastructure/queue/tenant-provisioning-queue.js";
import type {
  ClaimedProvisioningJob,
  ProvisioningJobPublisher,
} from "../application/dispatch-provisioning-jobs.js";

export function createBullMqProvisioningJobPublisher(
  queue: TenantProvisioningQueue,
): ProvisioningJobPublisher {
  return {
    async publish(job: ClaimedProvisioningJob): Promise<void> {
      // jobId = provisioning_jobs.id (ADR-002): a repeated publish for the same job resolves
      // to the existing BullMQ job instead of creating a second logical unit of work, as
      // long as that job hasn't already completed and been removed from Redis.
      //
      // attempts: 1 makes BullMQ's "no automatic retry" behavior explicit rather than an
      // implicit default. Provisioning retry is not designed yet (see ARCHITECTURE.md); the
      // worker persists FAILED as a terminal state, and BullMQ must not reinvent that policy
      // on its own by retrying the job.
      await queue.add(
        PROVISION_TENANT_JOB_NAME,
        { provisioningJobId: job.id, tenantId: job.tenantId },
        { jobId: job.id, attempts: 1 },
      );
    },
  };
}
