import { describe, expect, it } from "vitest";

import {
  processProvisioningJob,
  PROVISION_DATABASE_STEP,
  ProvisioningJobNotFoundError,
  ProvisioningJobTenantMismatchError,
  type DatabaseProvisioner,
  type ProcessProvisioningJobRepository,
  type ProvisioningJobSnapshot,
  type ProvisioningJobStatus,
} from "./process-provisioning-job.js";

const JOB_ID = "job-1";
const TENANT_ID = "tenant-1";

// Arbitrary but internally consistent — only used to satisfy DatabaseProvisioner's return
// type; no test in this file inspects its fields.
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
}

function fakeRepository(options: FakeRepositoryOptions = {}) {
  const calls: { markRunning: string[]; markSucceeded: string[]; markFailed: [string, string][] } = {
    markRunning: [],
    markSucceeded: [],
    markFailed: [],
  };

  const snapshot: ProvisioningJobSnapshot = {
    id: JOB_ID,
    tenantId: options.tenantId ?? TENANT_ID,
    status: options.status ?? "PENDING",
  };

  const repository: ProcessProvisioningJobRepository = {
    findById: async (id) => (options.missing || id !== JOB_ID ? undefined : snapshot),
    markRunning: async (id, currentStep) => {
      calls.markRunning.push(id);
      if (options.markRunningReturnsUndefined) {
        return undefined;
      }
      expect(currentStep).toBe(PROVISION_DATABASE_STEP);
      return { ...snapshot, status: "RUNNING" };
    },
    markSucceeded: async (id) => {
      calls.markSucceeded.push(id);
    },
    markFailed: async (id, errorMessage) => {
      calls.markFailed.push([id, errorMessage]);
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

describe("processProvisioningJob", () => {
  it("PENDING + provisioner success → RUNNING → SUCCEEDED", async () => {
    const { repository, calls } = fakeRepository({ status: "PENDING" });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner("succeed");

    const outcome = await processProvisioningJob(repository, provisioner, {
      provisioningJobId: JOB_ID,
      tenantId: TENANT_ID,
    });

    expect(calls.markRunning).toEqual([JOB_ID]);
    expect(provisionerCalls).toEqual([{ provisioningJobId: JOB_ID, tenantId: TENANT_ID }]);
    expect(calls.markSucceeded).toEqual([JOB_ID]);
    expect(calls.markFailed).toEqual([]);
    expect(outcome).toEqual({ outcome: "succeeded" });
  });

  it("PENDING + provisioner throws → RUNNING → FAILED with a sanitized message", async () => {
    const { repository, calls } = fakeRepository({ status: "PENDING" });
    const { provisioner } = fakeProvisioner("throw");

    const outcome = await processProvisioningJob(repository, provisioner, {
      provisioningJobId: JOB_ID,
      tenantId: TENANT_ID,
    });

    expect(calls.markRunning).toEqual([JOB_ID]);
    expect(calls.markSucceeded).toEqual([]);
    expect(calls.markFailed).toEqual([[JOB_ID, "provisioning boom"]]);
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

    const outcome = await processProvisioningJob(repository, provisioner, {
      provisioningJobId: JOB_ID,
      tenantId: TENANT_ID,
    });

    expect(outcome.outcome).toBe("failed");
    const [, persistedMessage] = calls.markFailed[0]!;
    expect(persistedMessage.length).toBeLessThan(600);
    expect(persistedMessage.endsWith("…")).toBe(true);
  });

  it("does not call the provisioner when the job is already SUCCEEDED", async () => {
    const { repository } = fakeRepository({ status: "SUCCEEDED" });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    const outcome = await processProvisioningJob(repository, provisioner, {
      provisioningJobId: JOB_ID,
      tenantId: TENANT_ID,
    });

    expect(provisionerCalls).toEqual([]);
    expect(outcome).toEqual({ outcome: "skipped", reason: "already-succeeded" });
  });

  it("does not call the provisioner when the job is already FAILED", async () => {
    const { repository } = fakeRepository({ status: "FAILED" });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    const outcome = await processProvisioningJob(repository, provisioner, {
      provisioningJobId: JOB_ID,
      tenantId: TENANT_ID,
    });

    expect(provisionerCalls).toEqual([]);
    expect(outcome).toEqual({ outcome: "skipped", reason: "already-failed" });
  });

  it("does not call the provisioner again when the job is already RUNNING", async () => {
    const { repository, calls } = fakeRepository({ status: "RUNNING" });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    const outcome = await processProvisioningJob(repository, provisioner, {
      provisioningJobId: JOB_ID,
      tenantId: TENANT_ID,
    });

    expect(calls.markRunning).toEqual([]);
    expect(provisionerCalls).toEqual([]);
    expect(outcome).toEqual({ outcome: "skipped", reason: "already-running" });
  });

  it("skips without calling the provisioner when the guarded claim loses a race", async () => {
    const { repository } = fakeRepository({ status: "PENDING", markRunningReturnsUndefined: true });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    const outcome = await processProvisioningJob(repository, provisioner, {
      provisioningJobId: JOB_ID,
      tenantId: TENANT_ID,
    });

    expect(provisionerCalls).toEqual([]);
    expect(outcome).toEqual({ outcome: "skipped", reason: "lost-claim-race" });
  });

  it("throws when the provisioning job does not exist", async () => {
    const { repository } = fakeRepository({ missing: true });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    await expect(
      processProvisioningJob(repository, provisioner, {
        provisioningJobId: JOB_ID,
        tenantId: TENANT_ID,
      }),
    ).rejects.toThrow(ProvisioningJobNotFoundError);

    expect(provisionerCalls).toEqual([]);
  });

  it("throws without calling the provisioner when tenantId does not match", async () => {
    const { repository } = fakeRepository({ status: "PENDING", tenantId: "actual-tenant" });
    const { provisioner, calls: provisionerCalls } = fakeProvisioner();

    await expect(
      processProvisioningJob(repository, provisioner, {
        provisioningJobId: JOB_ID,
        tenantId: "payload-tenant",
      }),
    ).rejects.toThrow(ProvisioningJobTenantMismatchError);

    expect(provisionerCalls).toEqual([]);
  });

  it("propagates the error if persisting FAILED itself fails", async () => {
    const { repository } = fakeRepository({ status: "PENDING", markFailedFails: true });
    const { provisioner } = fakeProvisioner("throw");

    await expect(
      processProvisioningJob(repository, provisioner, {
        provisioningJobId: JOB_ID,
        tenantId: TENANT_ID,
      }),
    ).rejects.toThrow("postgres unavailable while persisting FAILED");
  });
});
