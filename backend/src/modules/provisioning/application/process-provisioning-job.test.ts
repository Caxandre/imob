import { describe, expect, it } from "vitest";

import {
  startPendingProvisioningJob,
  PROVISION_DATABASE_STEP,
  ProvisioningExecutionOwnershipLostError,
  ProvisioningJobNotFoundError,
  ProvisioningJobTenantMismatchError,
  type DatabaseProvisioner,
  type ExecutionClaim,
  type FinalizeProvisioningInput,
  type ProcessProvisioningJobRepository,
  type ProvisioningExecutionOptions,
  type ProvisioningJobSnapshot,
  type ProvisioningJobStatus,
} from "./process-provisioning-job.js";

const JOB_ID = "job-1";
const TENANT_ID = "tenant-1";
const EXECUTION_TOKEN = "11111111-1111-1111-1111-111111111111";

// Large enough that the heartbeat timer never actually fires during a fake-repository unit
// test (these resolve in microtasks, well under any real interval) — the heartbeat's own
// renewal behavior is exercised for real in the Drizzle repository integration tests instead.
const EXECUTION_OPTIONS: ProvisioningExecutionOptions = { leaseSeconds: 60, heartbeatIntervalMs: 999_999 };

// Arbitrary but internally consistent — only used to satisfy DatabaseProvisioner's return
// type; no test in this file inspects its fields beyond confirming it reaches finalizeProvisioning.
const FAKE_PROVISIONING_RESULT = {
  clusterId: "cluster-1",
  databaseName: "tenant_fake",
  secretReference: "tenant-databases/fake",
  schemaVersion: 1,
};

interface FakeRepositoryOptions {
  status?: ProvisioningJobStatus;
  missing?: boolean;
  tenantId?: string;
  markRunningReturnsUndefined?: boolean;
  markFailedFails?: boolean;
  finalizeProvisioningFails?: boolean;
  finalizeProvisioningLosesOwnership?: boolean;
  markFailedLosesOwnership?: boolean;
}

function fakeRepository(options: FakeRepositoryOptions = {}) {
  const calls: {
    markRunning: string[];
    finalizeProvisioning: FinalizeProvisioningInput[];
    markFailed: [string, string, string][];
  } = {
    markRunning: [],
    finalizeProvisioning: [],
    markFailed: [],
  };

  const snapshot: ProvisioningJobSnapshot = {
    id: JOB_ID,
    tenantId: options.tenantId ?? TENANT_ID,
    status: options.status ?? "PENDING",
  };

  const repository: ProcessProvisioningJobRepository = {
    findById: async (id) => (options.missing || id !== JOB_ID ? undefined : snapshot),
    markRunning: async (id, currentStep, leaseSeconds) => {
      calls.markRunning.push(id);
      if (options.markRunningReturnsUndefined) {
        return undefined;
      }
      expect(currentStep).toBe(PROVISION_DATABASE_STEP);
      expect(leaseSeconds).toBe(EXECUTION_OPTIONS.leaseSeconds);
      return { id: snapshot.id, tenantId: snapshot.tenantId, executionToken: EXECUTION_TOKEN };
    },
    claimExpiredRunningJobs: async () => [],
    renewExecutionLease: async () => true,
    finalizeProvisioning: async (input) => {
      calls.finalizeProvisioning.push(input);
      if (options.finalizeProvisioningLosesOwnership) {
        throw new ProvisioningExecutionOwnershipLostError(input.provisioningJobId);
      }
      if (options.finalizeProvisioningFails) {
        throw new Error("control plane unavailable during finalization");
      }
    },
    markFailed: async (id, executionToken, errorMessage) => {
      calls.markFailed.push([id, executionToken, errorMessage]);
      if (options.markFailedLosesOwnership) {
        throw new ProvisioningExecutionOwnershipLostError(id);
      }
      if (options.markFailedFails) {
        throw new Error("postgres unavailable while persisting FAILED");
      }
    },
  };

  return { repository, calls };
}

function fakeProvisioner(behavior: "succeed" | "throw" = "succeed") {
  const calls: { provisioningJobId: string; tenantId: string }[] = [];

  const provisioner: DatabaseProvisioner = {
    provision: async (input) => {
      calls.push(input);
      if (behavior === "throw") {
        throw new Error("provisioning boom");
      }
      return FAKE_PROVISIONING_RESULT;
    },
  };

  return { provisioner, calls };
}

describe("startPendingProvisioningJob", () => {
  it("PENDING + provisioner success → RUNNING → finalized → SUCCEEDED", async () => {
    const { repository, calls } = fakeRepository({ status: "PENDING" });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner("succeed");

    const outcome = await startPendingProvisioningJob(
      repository,
      provisioner,
      { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
      EXECUTION_OPTIONS,
    );

    expect(calls.markRunning).toEqual([JOB_ID]);
    expect(provisionerCalls).toEqual([{ provisioningJobId: JOB_ID, tenantId: TENANT_ID }]);
    expect(calls.finalizeProvisioning).toEqual([
      {
        provisioningJobId: JOB_ID,
        tenantId: TENANT_ID,
        executionToken: EXECUTION_TOKEN,
        result: FAKE_PROVISIONING_RESULT,
      },
    ]);
    expect(calls.markFailed).toEqual([]);
    expect(outcome).toEqual({ outcome: "succeeded" });
  });

  it("PENDING + provisioner throws → RUNNING → FAILED with a sanitized message, never finalized", async () => {
    const { repository, calls } = fakeRepository({ status: "PENDING" });
    const { provisioner } = fakeProvisioner("throw");

    const outcome = await startPendingProvisioningJob(
      repository,
      provisioner,
      { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
      EXECUTION_OPTIONS,
    );

    expect(calls.markRunning).toEqual([JOB_ID]);
    expect(calls.finalizeProvisioning).toEqual([]);
    expect(calls.markFailed).toEqual([[JOB_ID, EXECUTION_TOKEN, "provisioning boom"]]);
    expect(outcome).toEqual({ outcome: "failed", errorMessage: "provisioning boom" });
  });

  it("truncates an overly long provisioner error message", async () => {
    const { repository, calls } = fakeRepository({ status: "PENDING" });
    const longMessage = "x".repeat(1000);
    const provisioner: DatabaseProvisioner = {
      provision: async () => {
        throw new Error(longMessage);
      },
    };

    const outcome = await startPendingProvisioningJob(
      repository,
      provisioner,
      { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
      EXECUTION_OPTIONS,
    );

    expect(outcome.outcome).toBe("failed");
    const [, , persistedMessage] = calls.markFailed[0]!;
    expect(persistedMessage.length).toBeLessThan(600);
    expect(persistedMessage.endsWith("…")).toBe(true);
  });

  it("does not call the provisioner when the job is already SUCCEEDED", async () => {
    const { repository } = fakeRepository({ status: "SUCCEEDED" });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    const outcome = await startPendingProvisioningJob(
      repository,
      provisioner,
      { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
      EXECUTION_OPTIONS,
    );

    expect(provisionerCalls).toEqual([]);
    expect(outcome).toEqual({ outcome: "skipped", reason: "already-succeeded" });
  });

  it("does not call the provisioner when the job is already FAILED", async () => {
    const { repository } = fakeRepository({ status: "FAILED" });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    const outcome = await startPendingProvisioningJob(
      repository,
      provisioner,
      { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
      EXECUTION_OPTIONS,
    );

    expect(provisionerCalls).toEqual([]);
    expect(outcome).toEqual({ outcome: "skipped", reason: "already-failed" });
  });

  it("does not call the provisioner again when the job is already RUNNING", async () => {
    const { repository, calls } = fakeRepository({ status: "RUNNING" });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    const outcome = await startPendingProvisioningJob(
      repository,
      provisioner,
      { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
      EXECUTION_OPTIONS,
    );

    expect(calls.markRunning).toEqual([]);
    expect(provisionerCalls).toEqual([]);
    expect(outcome).toEqual({ outcome: "skipped", reason: "already-running" });
  });

  it("skips without calling the provisioner when the guarded claim loses a race", async () => {
    const { repository } = fakeRepository({ status: "PENDING", markRunningReturnsUndefined: true });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    const outcome = await startPendingProvisioningJob(
      repository,
      provisioner,
      { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
      EXECUTION_OPTIONS,
    );

    expect(provisionerCalls).toEqual([]);
    expect(outcome).toEqual({ outcome: "skipped", reason: "lost-claim-race" });
  });

  it("throws when the provisioning job does not exist", async () => {
    const { repository } = fakeRepository({ missing: true });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    await expect(
      startPendingProvisioningJob(
        repository,
        provisioner,
        { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
        EXECUTION_OPTIONS,
      ),
    ).rejects.toThrow(ProvisioningJobNotFoundError);

    expect(provisionerCalls).toEqual([]);
  });

  it("throws without calling the provisioner when tenantId does not match", async () => {
    const { repository } = fakeRepository({ status: "PENDING", tenantId: "actual-tenant" });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    await expect(
      startPendingProvisioningJob(
        repository,
        provisioner,
        { provisioningJobId: JOB_ID, tenantId: "payload-tenant" },
        EXECUTION_OPTIONS,
      ),
    ).rejects.toThrow(ProvisioningJobTenantMismatchError);

    expect(provisionerCalls).toEqual([]);
  });

  it("propagates the error if persisting FAILED itself fails", async () => {
    const { repository } = fakeRepository({ status: "PENDING", markFailedFails: true });
    const { provisioner } = fakeProvisioner("throw");

    await expect(
      startPendingProvisioningJob(
        repository,
        provisioner,
        { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
        EXECUTION_OPTIONS,
      ),
    ).rejects.toThrow("postgres unavailable while persisting FAILED");
  });

  it("propagates the error if finalization fails, without ever calling markFailed", async () => {
    // Section 20-23: infra provisioning succeeded — only the Control Plane finalization
    // failed. The job must not be marked FAILED (that would make a fully working tenant
    // database unreachable from a future retry) — the error just propagates.
    const { repository, calls } = fakeRepository({ status: "PENDING", finalizeProvisioningFails: true });
    const { provisioner } = fakeProvisioner("succeed");

    await expect(
      startPendingProvisioningJob(
        repository,
        provisioner,
        { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
        EXECUTION_OPTIONS,
      ),
    ).rejects.toThrow("control plane unavailable during finalization");

    expect(calls.finalizeProvisioning).toHaveLength(1);
    expect(calls.markFailed).toEqual([]);
  });

  it("resolves as skipped/ownership-lost when finalization detects a stolen lease, without throwing", async () => {
    const { repository } = fakeRepository({ status: "PENDING", finalizeProvisioningLosesOwnership: true });
    const { provisioner } = fakeProvisioner("succeed");

    const outcome = await startPendingProvisioningJob(
      repository,
      provisioner,
      { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
      EXECUTION_OPTIONS,
    );

    expect(outcome).toEqual({ outcome: "skipped", reason: "ownership-lost" });
  });

  it("resolves as skipped/ownership-lost when markFailed detects a stolen lease, without throwing", async () => {
    const { repository } = fakeRepository({ status: "PENDING", markFailedLosesOwnership: true });
    const { provisioner } = fakeProvisioner("throw");

    const outcome = await startPendingProvisioningJob(
      repository,
      provisioner,
      { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
      EXECUTION_OPTIONS,
    );

    expect(outcome).toEqual({ outcome: "skipped", reason: "ownership-lost" });
  });
});

describe("ExecutionClaim wiring", () => {
  it("threads the executionToken markRunning returns through to finalizeProvisioning", async () => {
    const { repository, calls } = fakeRepository({ status: "PENDING" });
    const { provisioner } = fakeProvisioner("succeed");
    const claim: ExecutionClaim = { id: JOB_ID, tenantId: TENANT_ID, executionToken: EXECUTION_TOKEN };

    await startPendingProvisioningJob(
      repository,
      provisioner,
      { provisioningJobId: JOB_ID, tenantId: TENANT_ID },
      EXECUTION_OPTIONS,
    );

    expect(calls.finalizeProvisioning[0]?.executionToken).toBe(claim.executionToken);
  });
});
