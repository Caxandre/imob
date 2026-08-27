import type { ExecutionHeartbeatEvent } from "./execution-heartbeat.js";
import { startExecutionHeartbeat } from "./execution-heartbeat.js";
import type { ProvisioningResult } from "./provisioning-result.js";

export type ProvisioningJobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

/** The only provisioning step that exists today — see ARCHITECTURE.md. */
export const PROVISION_DATABASE_STEP = "PROVISION_DATABASE";

const MAX_ERROR_MESSAGE_LENGTH = 500;

export interface ProvisioningJobSnapshot {
  id: string;
  tenantId: string;
  status: ProvisioningJobStatus;
}

/**
 * A single execution's claim on a `RUNNING` job — either freshly acquired
 * (`markRunning`) or reclaimed from an abandoned one (`claimExpiredRunningJobs`).
 * `executionToken` is this execution's proof of ownership: every terminal write
 * (`finalizeProvisioning`, `markFailed`) and every heartbeat renewal must present it, and is
 * rejected if the job's persisted token no longer matches (ADR-003 "Recovery" — stale worker
 * fencing).
 */
export interface ExecutionClaim {
  id: string;
  tenantId: string;
  executionToken: string;
}

export interface FinalizeProvisioningInput {
  provisioningJobId: string;
  tenantId: string;
  executionToken: string;
  result: ProvisioningResult;
}

/**
 * Raised when a write requiring ownership of a job's execution lease (`finalizeProvisioning`,
 * `markFailed`) finds the job still `RUNNING` but owned by a *different* execution token —
 * this execution's lease expired and another one already claimed the job (ADR-003
 * "Recovery"). The caller must stop immediately: not finalize, not mark failed, not retry —
 * the new execution owns this job now. Never raised for an already-terminal job whose token
 * was cleared by its own successful commit (see `finalizeProvisioning`'s idempotent-retry
 * path, which never compares tokens once `SUCCEEDED`).
 */
export class ProvisioningExecutionOwnershipLostError extends Error {
  constructor(provisioningJobId: string) {
    super(
      `Provisioning job "${provisioningJobId}" is no longer owned by this execution — its ` +
        "lease was reassigned to another execution",
    );
    this.name = "ProvisioningExecutionOwnershipLostError";
  }
}

/**
 * Persistence port for the provisioning workflow. PostgreSQL is the source of truth (ADR-002)
 * — the worker always consults it before acting, never BullMQ's own job state.
 */
export interface ProcessProvisioningJobRepository {
  findById(id: string): Promise<ProvisioningJobSnapshot | undefined>;
  /**
   * Guarded PENDING → RUNNING transition, granting a fresh execution lease in the same
   * atomic write (ADR-003 "Recovery"): the write itself is the concurrency arbiter (`WHERE
   * status = 'PENDING'`). Returns undefined if the job was no longer PENDING.
   */
  markRunning(id: string, currentStep: string, leaseSeconds: number): Promise<ExecutionClaim | undefined>;
  /**
   * Reclaims up to `batchSize` `RUNNING` jobs whose execution lease has expired (or was never
   * set — a job left `RUNNING` from before this mechanism existed), granting each a fresh
   * execution token/lease and incrementing `attempts` (a reclaim is a real new execution
   * attempt, same as the original `PENDING → RUNNING` transition). Status stays `RUNNING` —
   * this is not a redispatch through the dispatcher/BullMQ (ADR-002's `dispatched_at` and
   * friends are untouched); the job was already delivered once, and this only resumes
   * execution of it.
   */
  claimExpiredRunningJobs(input: { batchSize: number; leaseSeconds: number }): Promise<ExecutionClaim[]>;
  /**
   * Renews the execution lease for an in-progress `RUNNING` job — only if `executionToken`
   * still owns it. Returns `false` (never throws) when ownership was already lost, so
   * `execution-heartbeat.ts` can stop renewing without treating it as a transient error.
   */
  renewExecutionLease(id: string, executionToken: string, leaseSeconds: number): Promise<boolean>;
  /**
   * Atomically persists a completed `ProvisioningResult` into the Control Plane, within a
   * single PostgreSQL transaction (ADR-003 "Finalization"): reconciles/creates
   * `tenant_databases`, activates the tenant (`tenants.status = READY`), and marks the job
   * `SUCCEEDED` — all three, or none. Idempotent: safe to call again for a job already
   * `SUCCEEDED`/tenant already `READY`, as long as the persisted state is compatible with
   * the same `result`; throws on any real inconsistency (job/tenant in an incompatible
   * state, or an existing `tenant_databases` row that doesn't match `result`) instead of
   * silently overwriting anything. Requires `executionToken` to still own the job while it is
   * `RUNNING` (throws {@link ProvisioningExecutionOwnershipLostError} otherwise) — but never
   * re-checks it once the job is already `SUCCEEDED`, since a prior successful commit already
   * cleared the token.
   */
  finalizeProvisioning(input: FinalizeProvisioningInput): Promise<void>;
  /**
   * Guarded RUNNING → FAILED transition, requiring `executionToken` to still own the job.
   * Silently does nothing if the job is no longer `RUNNING` at all (already terminal — the
   * pre-existing guard). Throws {@link ProvisioningExecutionOwnershipLostError} specifically
   * when the job is still `RUNNING` but owned by a different execution token.
   */
  markFailed(id: string, executionToken: string, errorMessage: string): Promise<void>;
}

/**
 * Provisions the tenant's actual database infrastructure and returns the result the
 * application layer needs to finalize the workflow in the Control Plane (ADR-003) — this
 * port itself never writes to `tenants`/`provisioning_jobs`/`tenant_databases`.
 *
 * A real implementation exists as of Prompt 017
 * (`../infrastructure/postgres-database-provisioner.ts`), wired into the worker since Prompt
 * 018. Never implement this port with a no-op/fake outside of tests — doing so in the real
 * worker would mark real provisioning jobs SUCCEEDED without ever creating anything.
 */
export interface DatabaseProvisioner {
  provision(input: { provisioningJobId: string; tenantId: string }): Promise<ProvisioningResult>;
}

/**
 * Wraps a failed provisioning step with a controlled, step-specific message (ADR-003
 * "Security") — never the raw driver/PostgreSQL error text, which could in principle echo
 * sensitive detail. The original error is preserved only on `.cause`, for structured logging,
 * never for the value that ends up in `provisioning_jobs.error_message`
 * (`toSanitizedErrorMessage` below only ever reads `.message`).
 */
export class DatabaseProvisioningError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "DatabaseProvisioningError";
  }
}

export class ProvisioningJobNotFoundError extends Error {
  constructor(public readonly provisioningJobId: string) {
    super(`Provisioning job "${provisioningJobId}" was not found`);
    this.name = "ProvisioningJobNotFoundError";
  }
}

export class ProvisioningJobTenantMismatchError extends Error {
  constructor(
    public readonly provisioningJobId: string,
    public readonly expectedTenantId: string,
    public readonly actualTenantId: string,
  ) {
    super(
      `Provisioning job "${provisioningJobId}" belongs to tenant "${expectedTenantId}", but the ` +
        `message payload named tenant "${actualTenantId}"`,
    );
    this.name = "ProvisioningJobTenantMismatchError";
  }
}

/**
 * Raised by `finalizeProvisioning()` when the provisioning job is not in a state finalization
 * can act on — neither `RUNNING` (the normal case) nor an already-`SUCCEEDED` job whose
 * persisted state is compatible with the same result (the idempotent-retry case). A job that
 * is `PENDING` or `FAILED` must never be finalized.
 */
export class InvalidProvisioningJobStateError extends Error {
  constructor(provisioningJobId: string, reason: string) {
    super(`Provisioning job "${provisioningJobId}" cannot be finalized: ${reason}`);
    this.name = "InvalidProvisioningJobStateError";
  }
}

/**
 * Raised by `finalizeProvisioning()` when the tenant is not in a state compatible with being
 * marked `READY` — neither `PROVISIONING` (the normal case) nor already `READY` (the
 * idempotent-retry case). A tenant that is `SUSPENDED` or `FAILED` must never be silently
 * flipped to `READY`.
 */
export class TenantProvisioningStateError extends Error {
  constructor(tenantId: string, actualStatus: string) {
    super(`Tenant "${tenantId}" cannot be marked READY from status "${actualStatus}"`);
    this.name = "TenantProvisioningStateError";
  }
}

/**
 * Raised by `finalizeProvisioning()` when a `tenant_databases` row already exists for this
 * tenant but disagrees with the given `ProvisioningResult` on cluster/database/secret/schema
 * version. Never silently overwritten — a real divergence here means something is
 * inconsistent and must be investigated, not papered over.
 */
export class ProvisioningFinalizationConflictError extends Error {
  constructor(tenantId: string) {
    super(
      `Tenant "${tenantId}" already has a tenant_databases record that is incompatible with ` +
        "this ProvisioningResult",
    );
    this.name = "ProvisioningFinalizationConflictError";
  }
}

export type ProcessProvisioningJobOutcome =
  | { outcome: "succeeded" }
  | { outcome: "failed"; errorMessage: string }
  | {
      outcome: "skipped";
      reason: "already-succeeded" | "already-failed" | "already-running" | "lost-claim-race" | "ownership-lost";
    };

export interface ProcessProvisioningJobInput {
  provisioningJobId: string;
  tenantId: string;
}

/**
 * Shared execution tuning, threaded through both the normal (`startPendingProvisioningJob`)
 * and recovery (`recoverExpiredRunningJobsOnce`) paths — both ultimately call
 * `executeRunningProvisioningJob`, so both need the same lease/heartbeat configuration.
 * `onHeartbeatEvent` is optional and infra-free (see `execution-heartbeat.ts`) — the caller
 * decides whether/how to log it.
 */
export interface ProvisioningExecutionOptions {
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  onHeartbeatEvent?: (event: ExecutionHeartbeatEvent) => void;
}

function toSanitizedErrorMessage(error: unknown): string {
  // Only ever the message, never a stack trace. DatabaseProvisioner implementations are
  // responsible for not throwing messages that contain secrets/credentials/connection
  // strings — truncation alone cannot guarantee that, it only bounds the size.
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;
}

/**
 * Runs `DatabaseProvisioner.provision()` followed by Control Plane finalization for a job
 * this execution already owns the lease for — used both right after a fresh
 * `PENDING → RUNNING` claim and after reclaiming an abandoned `RUNNING` job (ADR-003
 * "Recovery"); either way, by the time this is called, `claim.executionToken` is this
 * execution's proof of ownership. Runs a heartbeat for the whole duration, stopped in
 * `finally` no matter the outcome.
 *
 * Distinguishes three outcomes, never conflating them:
 * - `provision()` fails → `markFailed` (unless ownership was already lost — see below).
 * - `provision()` succeeds but this execution has since lost ownership (a stale worker
 *   resuming after another execution already reclaimed the job) → skipped, nothing written.
 * - `provision()` succeeds and finalization commits → `succeeded`.
 *
 * A finalization failure that is *not* an ownership loss (e.g. a transient PostgreSQL error)
 * propagates uncaught, exactly as before Prompt 019: the job is left `RUNNING`, recoverable
 * by a future claim.
 */
export async function executeRunningProvisioningJob(
  repository: ProcessProvisioningJobRepository,
  provisioner: DatabaseProvisioner,
  claim: ExecutionClaim,
  options: ProvisioningExecutionOptions,
): Promise<ProcessProvisioningJobOutcome> {
  const heartbeat = startExecutionHeartbeat(
    repository,
    { id: claim.id, executionToken: claim.executionToken },
    { leaseSeconds: options.leaseSeconds, intervalMs: options.heartbeatIntervalMs, onEvent: options.onHeartbeatEvent },
  );

  try {
    let result: ProvisioningResult;
    try {
      result = await provisioner.provision({ provisioningJobId: claim.id, tenantId: claim.tenantId });
    } catch (error) {
      const errorMessage = toSanitizedErrorMessage(error);
      try {
        // If this itself throws for any other reason (e.g. PostgreSQL unavailable), it
        // propagates uncaught: we cannot claim the workflow was persisted as FAILED, so the
        // caller must observe the failure rather than have it swallowed here.
        await repository.markFailed(claim.id, claim.executionToken, errorMessage);
      } catch (markFailedError) {
        if (markFailedError instanceof ProvisioningExecutionOwnershipLostError) {
          return { outcome: "skipped", reason: "ownership-lost" };
        }
        throw markFailedError;
      }
      return { outcome: "failed", errorMessage };
    }

    // External infrastructure provisioning already succeeded at this point — provision()
    // returned. A failure here is a Control Plane finalization problem (e.g. a transient
    // PostgreSQL error), never evidence that provisioning itself failed. Deliberately does
    // NOT call markFailed: the provisioner is idempotent by discovery (ADR-003), so a future
    // retry — including this task's recovery claim — can redo this whole call safely and
    // finish the finalization. Marking FAILED here would make a fully working tenant
    // database permanently unreachable from any retry.
    try {
      await repository.finalizeProvisioning({
        provisioningJobId: claim.id,
        tenantId: claim.tenantId,
        executionToken: claim.executionToken,
        result,
      });
    } catch (error) {
      if (error instanceof ProvisioningExecutionOwnershipLostError) {
        return { outcome: "skipped", reason: "ownership-lost" };
      }
      throw error;
    }
    return { outcome: "succeeded" };
  } finally {
    heartbeat.stop();
  }
}

/**
 * Entry point for a fresh delivery of a job (BullMQ, normally `PENDING`). Safe to call more
 * than once for the same job — `PENDING` is the only state from which a real attempt is
 * made; every other state resolves idempotently without touching the provisioner. Once
 * claimed, delegates to `executeRunningProvisioningJob` for the actual work — see there for
 * failure semantics.
 */
export async function startPendingProvisioningJob(
  repository: ProcessProvisioningJobRepository,
  provisioner: DatabaseProvisioner,
  input: ProcessProvisioningJobInput,
  options: ProvisioningExecutionOptions,
): Promise<ProcessProvisioningJobOutcome> {
  const job = await repository.findById(input.provisioningJobId);

  if (!job) {
    throw new ProvisioningJobNotFoundError(input.provisioningJobId);
  }

  if (job.tenantId !== input.tenantId) {
    throw new ProvisioningJobTenantMismatchError(input.provisioningJobId, job.tenantId, input.tenantId);
  }

  if (job.status === "SUCCEEDED") {
    return { outcome: "skipped", reason: "already-succeeded" };
  }

  if (job.status === "FAILED") {
    return { outcome: "skipped", reason: "already-failed" };
  }

  if (job.status === "RUNNING") {
    // Abandoned-RUNNING recovery is handled separately (recoverExpiredRunningJobsOnce) —
    // never attempted here, from a fresh BullMQ delivery.
    return { outcome: "skipped", reason: "already-running" };
  }

  const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP, options.leaseSeconds);

  if (!claimed) {
    // Lost a race against another delivery of the same job between the read above and this
    // guarded write — safe to skip, the other execution now owns this attempt.
    return { outcome: "skipped", reason: "lost-claim-race" };
  }

  return executeRunningProvisioningJob(repository, provisioner, claimed, options);
}
