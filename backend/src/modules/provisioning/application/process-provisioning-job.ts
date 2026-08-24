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
  /** Guarded RUNNING → SUCCEEDED transition. */
  markSucceeded(id: string): Promise<void>;
  /** Guarded RUNNING → FAILED transition. */
  markFailed(id: string, errorMessage: string): Promise<void>;
}

/**
 * Provisions the tenant's actual database infrastructure. No real implementation exists yet
 * — creating a PostgreSQL database is out of scope for this task (see ARCHITECTURE.md).
 *
 * Never implement this port with a no-op/fake outside of tests. Doing so in the real worker
 * would mark real provisioning jobs SUCCEEDED without ever creating anything.
 */
export interface DatabaseProvisioner {
  provision(input: { provisioningJobId: string; tenantId: string }): Promise<void>;
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

  try {
    await provisioner.provision({ provisioningJobId: claimed.id, tenantId: claimed.tenantId });
    await repository.markSucceeded(claimed.id);
    return { outcome: "succeeded" };
  } catch (error) {
    const errorMessage = toSanitizedErrorMessage(error);
    // If this itself throws (e.g. PostgreSQL unavailable), it propagates uncaught: we
    // cannot claim the workflow was persisted as FAILED, so the caller must observe the
    // failure rather than have it swallowed here.
    await repository.markFailed(claimed.id, errorMessage);
    return { outcome: "failed", errorMessage };
  }
}
