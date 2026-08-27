import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";

import {
  PROVISION_TENANT_JOB_NAME,
  TENANT_PROVISIONING_QUEUE_NAME,
  type ProvisionTenantJobPayload,
} from "../../../infrastructure/queue/tenant-provisioning-queue.js";
import {
  startPendingProvisioningJob,
  type DatabaseProvisioner,
  type ProcessProvisioningJobRepository,
  type ProvisioningExecutionOptions,
} from "../application/process-provisioning-job.js";

export function createProvisioningWorker(
  connection: Redis,
  repository: ProcessProvisioningJobRepository,
  provisioner: DatabaseProvisioner,
  executionOptions: ProvisioningExecutionOptions,
): Worker<ProvisionTenantJobPayload> {
  return new Worker<ProvisionTenantJobPayload>(
    TENANT_PROVISIONING_QUEUE_NAME,
    async (job: Job<ProvisionTenantJobPayload>) => {
      if (job.name !== PROVISION_TENANT_JOB_NAME) {
        throw new Error(`Unexpected job name "${job.name}" on queue "${TENANT_PROVISIONING_QUEUE_NAME}"`);
      }

      // startPendingProvisioningJob throws only for genuine, unexpected conditions (job not
      // found, tenantId mismatch, or a failure persisting the outcome) — those should
      // surface to BullMQ. A provisioning failure that was successfully recorded as FAILED
      // resolves normally: FAILED is a terminal, already-persisted outcome, not a callback
      // failure — BullMQ must not reinvent provisioning retry policy (this task / ADR-002).
      await startPendingProvisioningJob(
        repository,
        provisioner,
        {
          provisioningJobId: job.data.provisioningJobId,
          tenantId: job.data.tenantId,
        },
        executionOptions,
      );
    },
    { connection },
  );
}
