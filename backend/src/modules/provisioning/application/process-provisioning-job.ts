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

export interface FinalizeProvisioningInput {
  provisioningJobId: string;
  tenantId: string;
  result: ProvisioningResult;
}

/**
 * Persistence port for the provisioning workflow. PostgreSQL is the source of truth (ADR-002)
 * — the worker always consults it before acting, never BullMQ's own job state.
 */
export interface ProcessProvisioningJobRepository {
  findById(id: string): Promise<ProvisioningJobSnapshot | undefined>;
  /**
   * Guarded PENDING → RUNNING transition: the write itself is the concurrency arbiter
   * (`WHERE status = 'PENDING'`). Returns undefined if the job was no longer PENDING.
   */
  markRunning(id: string, currentStep: string): Promise<ProvisioningJobSnapshot | undefined>;
  /**
   * Atomically persists a completed `ProvisioningResult` into the Control Plane, within a
   * single PostgreSQL transaction (ADR-003 "Finalization"): reconciles/creates
   * `tenant_databases`, activates the tenant (`tenants.status = READY`), and marks the job
   * `SUCCEEDED` — all three, or none. Idempotent: safe to call again for a job already
   * `SUCCEEDED`/tenant already `READY`, as long as the persisted state is compatible with
   * the same `result`; throws on any real inconsistency (job/tenant in an incompatible
   * state, or an existing `tenant_databases` row that doesn't match `result`) instead of
   * silently overwriting anything.
   */
  finalizeProvisioning(input: FinalizeProvisioningInput): Promise<void>;
  /** Guarded RUNNING → FAILED transition. */
  markFailed(id: string, errorMessage: string): Promise<void>;
}

/**
 * Provisions the tenant's actual database infrastructure and returns the result the
 * application layer needs to finalize the workflow in the Control Plane (ADR-003) — this
 * port itself never writes to `tenants`/`provisioning_jobs`/`tenant_databases`.
 *
 * A real implementation exists as of Prompt 017
 * (`../infrastructure/postgres-database-provisioner.ts`), but is not yet wired into this
 * worker: doing so requires extending `markSucceeded`/finalization to persist
 * `ProvisioningResult` into `tenant_databases` and activate the tenant, which is out of scope
 * here (see ARCHITECTURE.md/ADR-003 "Finalization"). Never implement this port with a
 * no-op/fake outside of tests — doing so in the real worker would mark real provisioning jobs
 * SUCCEEDED without ever creating anything.
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
      reason: "already-succeeded" | "already-failed" | "already-running" | "lost-claim-race";
    };

export interface ProcessProvisioningJobInput {
  provisioningJobId: string;
  tenantId: string;
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
 * Processes one delivery of a provisioning job against the persisted state machine. Safe to
 * call more than once for the same job — PENDING is the only state from which a real attempt
 * is made; every other state resolves idempotently without touching the provisioner.
 */
export async function processProvisioningJob(
  repository: ProcessProvisioningJobRepository,
  provisioner: DatabaseProvisioner,
  input: ProcessProvisioningJobInput,
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
    // Abandoned-RUNNING recovery is a separate, future concern — never attempted here.
    return { outcome: "skipped", reason: "already-running" };
  }

  const claimed = await repository.markRunning(job.id, PROVISION_DATABASE_STEP);

  if (!claimed) {
    // Lost a race against another delivery of the same job between the read above and this
    // guarded write — safe to skip, the other execution now owns this attempt.
    return { outcome: "skipped", reason: "lost-claim-race" };
  }

  let result: ProvisioningResult;
  try {
    result = await provisioner.provision({ provisioningJobId: claimed.id, tenantId: claimed.tenantId });
  } catch (error) {
    const errorMessage = toSanitizedErrorMessage(error);
    // If this itself throws (e.g. PostgreSQL unavailable), it propagates uncaught: we
    // cannot claim the workflow was persisted as FAILED, so the caller must observe the
    // failure rather than have it swallowed here.
    await repository.markFailed(claimed.id, errorMessage);
    return { outcome: "failed", errorMessage };
  }

  // External infrastructure provisioning already succeeded at this point — provision()
  // returned. A failure here is a Control Plane finalization problem (e.g. a transient
  // PostgreSQL error), never evidence that provisioning itself failed. Deliberately does
  // NOT call markFailed: the provisioner is idempotent by discovery (ADR-003), so a future
  // retry can redo this whole call safely and finish the finalization — marking FAILED here
  // would make a fully working tenant database permanently unreachable from any retry.
  // The job is left RUNNING and the error propagates uncaught, so the caller (BullMQ) sees
  // a genuine processing failure rather than a persisted terminal outcome. RUNNING recovery
  // after a crash mid-finalization remains a known, separate gap (ADR-002/ADR-003).
  await repository.finalizeProvisioning({
    provisioningJobId: claimed.id,
    tenantId: claimed.tenantId,
    result,
  });
  return { outcome: "succeeded" };
}
