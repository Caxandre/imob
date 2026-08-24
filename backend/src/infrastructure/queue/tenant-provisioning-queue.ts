import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const TENANT_PROVISIONING_QUEUE_NAME = "tenant-provisioning";
export const PROVISION_TENANT_JOB_NAME = "provision-tenant";

/**
 * Minimal payload by design (ADR-002): PostgreSQL stays the source of truth, so the job
 * only needs enough to look the provisioning job back up — never credentials or business
 * data.
 */
export interface ProvisionTenantJobPayload {
  provisioningJobId: string;
  tenantId: string;
}

export type TenantProvisioningQueue = Queue<ProvisionTenantJobPayload>;

export function createTenantProvisioningQueue(connection: Redis): TenantProvisioningQueue {
  return new Queue<ProvisionTenantJobPayload>(TENANT_PROVISIONING_QUEUE_NAME, { connection });
}
