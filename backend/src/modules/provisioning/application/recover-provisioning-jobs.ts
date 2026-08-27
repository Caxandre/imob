import { executeRunningProvisioningJob } from "./process-provisioning-job.js";
import type {
  DatabaseProvisioner,
  ExecutionClaim,
  ProcessProvisioningJobOutcome,
  ProcessProvisioningJobRepository,
  ProvisioningExecutionOptions,
} from "./process-provisioning-job.js";

export interface RecoverProvisioningJobsOptions extends ProvisioningExecutionOptions {
  batchSize: number;
}

export interface RecoveryResult {
  id: string;
  tenantId: string;
  /** Present when `executeRunningProvisioningJob` returned normally. */
  outcome?: ProcessProvisioningJobOutcome;
  /**
   * Present when it threw instead — the job's real persisted state (most likely still
   * `RUNNING`) must be re-observed by a future recovery cycle; never fabricate an outcome
   * here that doesn't reflect what was actually committed.
   */
  error?: unknown;
}

export interface RecoveryCycleSummary {
  claimedCount: number;
  results: RecoveryResult[];
}

/**
 * Runs a single recovery cycle (ADR-003 "Recovery"): reclaims `RUNNING` jobs whose execution
 * lease has expired, then resumes each one exactly as `startPendingProvisioningJob` would —
 * `DatabaseProvisioner.provision()` (idempotent by discovery, so already-completed steps are
 * simply rediscovered) followed by Control Plane finalization. Never redelivers through
 * BullMQ: the job was already delivered once, and by this point is already persisted as
 * `RUNNING` — this only resumes execution of it directly.
 *
 * Pure orchestration — no logging, no loop, no timers — so it can be exercised in tests
 * without starting the real worker process, mirroring `dispatchProvisioningJobsOnce`
 * (ADR-002). One job's failure never stops the rest of the batch.
 */
export async function recoverExpiredRunningJobsOnce(
  repository: ProcessProvisioningJobRepository,
  provisioner: DatabaseProvisioner,
  options: RecoverProvisioningJobsOptions,
): Promise<RecoveryCycleSummary> {
  const claimed: ExecutionClaim[] = await repository.claimExpiredRunningJobs({
    batchSize: options.batchSize,
    leaseSeconds: options.leaseSeconds,
  });

  const results: RecoveryResult[] = [];

  for (const claim of claimed) {
    try {
      const outcome = await executeRunningProvisioningJob(repository, provisioner, claim, options);
      results.push({ id: claim.id, tenantId: claim.tenantId, outcome });
    } catch (error) {
      results.push({ id: claim.id, tenantId: claim.tenantId, error });
    }
  }

  return { claimedCount: claimed.length, results };
}
