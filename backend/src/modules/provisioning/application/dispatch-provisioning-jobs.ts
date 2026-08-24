export interface ClaimedProvisioningJob {
  id: string;
  tenantId: string;
}

export interface ClaimEligibleJobsInput {
  batchSize: number;
  leaseSeconds: number;
}

/**
 * Persistence port for the dispatcher (ADR-002). Deliberately narrow — no generic
 * repository — and deliberately silent about *how* atomicity/locking is achieved; that is
 * an infrastructure concern.
 */
export interface ProvisioningDispatchRepository {
  /** Claims up to `batchSize` eligible jobs inside a short PostgreSQL transaction (Steps 1-2). */
  claimEligibleJobs(input: ClaimEligibleJobsInput): Promise<ClaimedProvisioningJob[]>;
  /** Confirms a successful publish (Step 4). No-op if the job was already dispatched. */
  markDispatched(jobId: string): Promise<void>;
  /** Releases a claim after a failed publish attempt, keeping the claim timestamp (Step 5). */
  releaseLease(jobId: string): Promise<void>;
}

/** Publishing port. The BullMQ adapter lives in infrastructure so this stays mockable. */
export interface ProvisioningJobPublisher {
  publish(job: ClaimedProvisioningJob): Promise<void>;
}

export interface ProvisioningDispatchResult extends ClaimedProvisioningJob {
  outcome: "dispatched" | "failed";
  error?: unknown;
}

export interface DispatchCycleSummary {
  claimedCount: number;
  results: ProvisioningDispatchResult[];
}

/**
 * Runs a single dispatch cycle: claim eligible jobs, then publish each one independently.
 * Pure orchestration — no logging, no loop, no timers — so it can be exercised in tests
 * without starting the real dispatcher process.
 */
export async function dispatchProvisioningJobsOnce(
  repository: ProvisioningDispatchRepository,
  publisher: ProvisioningJobPublisher,
  options: ClaimEligibleJobsInput,
): Promise<DispatchCycleSummary> {
  const claimed = await repository.claimEligibleJobs(options);

  const results: ProvisioningDispatchResult[] = [];

  for (const job of claimed) {
    try {
      await publisher.publish(job);
      await repository.markDispatched(job.id);
      results.push({ ...job, outcome: "dispatched" });
    } catch (error) {
      results.push({ ...job, outcome: "failed", error });

      // Best-effort: if releasing the lease also fails, the job still self-heals once
      // dispatch_lease_until naturally expires (ADR-002) — never let one job's failure stop
      // the rest of the batch from being processed.
      await repository.releaseLease(job.id).catch(() => undefined);
    }
  }

  return { claimedCount: claimed.length, results };
}
