import { describe, expect, it } from "vitest";

import type {
  DatabaseProvisioner,
  ExecutionClaim,
  FinalizeProvisioningInput,
  ProcessProvisioningJobRepository,
} from "./process-provisioning-job.js";
import { recoverExpiredRunningJobsOnce } from "./recover-provisioning-jobs.js";

const FAKE_RESULT = {
  clusterId: "cluster-1",
  databaseName: "tenant_fake",
  secretReference: "tenant-databases/fake",
  schemaVersion: 1,
};

function fakeClaim(id: string): ExecutionClaim {
  return { id, tenantId: `tenant-${id}`, executionToken: `token-${id}` };
}

interface FakeRepositoryOptions {
  claimed?: ExecutionClaim[];
  finalizeProvisioningFails?: (input: FinalizeProvisioningInput) => boolean;
}

function fakeRepository(options: FakeRepositoryOptions = {}) {
  const finalized: FinalizeProvisioningInput[] = [];
  const failed: string[] = [];

  const repository: ProcessProvisioningJobRepository = {
    findById: async () => undefined,
    markRunning: async () => undefined,
    claimExpiredRunningJobs: async () => options.claimed ?? [],
    renewExecutionLease: async () => true,
    finalizeProvisioning: async (input) => {
      finalized.push(input);
      if (options.finalizeProvisioningFails?.(input)) {
        throw new Error(`finalize boom for ${input.provisioningJobId}`);
      }
    },
    markFailed: async (id) => {
      failed.push(id);
    },
  };

  return { repository, finalized, failed };
}

function fakeProvisioner(shouldThrow: (tenantId: string) => boolean = () => false) {
  const calls: { provisioningJobId: string; tenantId: string }[] = [];

  const provisioner: DatabaseProvisioner = {
    provision: async (input) => {
      calls.push(input);
      if (shouldThrow(input.tenantId)) {
        throw new Error(`provision boom for ${input.tenantId}`);
      }
      return FAKE_RESULT;
    },
  };

  return { provisioner, calls };
}

const options = { batchSize: 10, leaseSeconds: 60, heartbeatIntervalMs: 999_999 };

describe("recoverExpiredRunningJobsOnce", () => {
  it("returns an empty summary when nothing is eligible", async () => {
    const { repository } = fakeRepository({ claimed: [] });
    const { provisioner } = fakeProvisioner();

    const summary = await recoverExpiredRunningJobsOnce(repository, provisioner, options);

    expect(summary).toEqual({ claimedCount: 0, results: [] });
  });

  it("resumes a reclaimed job through to a real outcome, never redispatching through a queue", async () => {
    const claim = fakeClaim("job-1");
    const { repository, finalized } = fakeRepository({ claimed: [claim] });
    const { provisioner, calls } = fakeProvisioner();

    const summary = await recoverExpiredRunningJobsOnce(repository, provisioner, options);

    expect(calls).toEqual([{ provisioningJobId: claim.id, tenantId: claim.tenantId }]);
    expect(finalized).toEqual([
      { provisioningJobId: claim.id, tenantId: claim.tenantId, executionToken: claim.executionToken, result: FAKE_RESULT },
    ]);
    expect(summary.claimedCount).toBe(1);
    expect(summary.results).toEqual([{ id: claim.id, tenantId: claim.tenantId, outcome: { outcome: "succeeded" } }]);
  });

  it("marks a job FAILED when the provisioner itself throws", async () => {
    const claim = fakeClaim("job-2");
    const { repository, failed } = fakeRepository({ claimed: [claim] });
    const { provisioner } = fakeProvisioner(() => true);

    const summary = await recoverExpiredRunningJobsOnce(repository, provisioner, options);

    expect(failed).toEqual([claim.id]);
    expect(summary.results[0]?.outcome).toMatchObject({ outcome: "failed" });
  });

  it("processes each claimed job independently — one job's finalization error never stops the batch", async () => {
    const failing = fakeClaim("job-fail");
    const succeeding = fakeClaim("job-ok");
    const { repository } = fakeRepository({
      claimed: [failing, succeeding],
      finalizeProvisioningFails: (input) => input.provisioningJobId === "job-fail",
    });
    const { provisioner } = fakeProvisioner();

    const summary = await recoverExpiredRunningJobsOnce(repository, provisioner, options);

    expect(summary.claimedCount).toBe(2);
    const failingResult = summary.results.find((result) => result.id === "job-fail");
    const okResult = summary.results.find((result) => result.id === "job-ok");
    expect(failingResult?.error).toBeInstanceOf(Error);
    expect(failingResult?.outcome).toBeUndefined();
    expect(okResult?.outcome).toEqual({ outcome: "succeeded" });
    expect(okResult?.error).toBeUndefined();
  });
});
