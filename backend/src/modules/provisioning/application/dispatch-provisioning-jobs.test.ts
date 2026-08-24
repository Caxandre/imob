import { describe, expect, it } from "vitest";

import {
  dispatchProvisioningJobsOnce,
  type ClaimedProvisioningJob,
  type ProvisioningDispatchRepository,
  type ProvisioningJobPublisher,
} from "./dispatch-provisioning-jobs.js";

function fakeJob(id: string): ClaimedProvisioningJob {
  return { id, tenantId: `tenant-${id}` };
}

interface FakeRepositoryOptions {
  claimed?: ClaimedProvisioningJob[];
  releaseLeaseFails?: boolean;
}

function fakeRepository(options: FakeRepositoryOptions = {}) {
  const dispatched: string[] = [];
  const released: string[] = [];

  const repository: ProvisioningDispatchRepository = {
    claimEligibleJobs: async () => options.claimed ?? [],
    markDispatched: async (jobId) => {
      dispatched.push(jobId);
    },
    releaseLease: async (jobId) => {
      released.push(jobId);
      if (options.releaseLeaseFails) {
        throw new Error("release lease boom");
      }
    },
  };

  return { repository, dispatched, released };
}

function fakePublisher(shouldFail: (job: ClaimedProvisioningJob) => boolean = () => false) {
  const published: ClaimedProvisioningJob[] = [];

  const publisher: ProvisioningJobPublisher = {
    publish: async (job) => {
      published.push(job);
      if (shouldFail(job)) {
        throw new Error(`publish boom for ${job.id}`);
      }
    },
  };

  return { publisher, published };
}

const options = { batchSize: 10, leaseSeconds: 30 };

describe("dispatchProvisioningJobsOnce", () => {
  it("returns an empty summary when nothing is eligible", async () => {
    const { repository } = fakeRepository({ claimed: [] });
    const { publisher } = fakePublisher();

    const summary = await dispatchProvisioningJobsOnce(repository, publisher, options);

    expect(summary).toEqual({ claimedCount: 0, results: [] });
  });

  it("marks a successfully published job as dispatched", async () => {
    const job = fakeJob("job-1");
    const { repository, dispatched, released } = fakeRepository({ claimed: [job] });
    const { publisher, published } = fakePublisher();

    const summary = await dispatchProvisioningJobsOnce(repository, publisher, options);

    expect(published).toEqual([job]);
    expect(dispatched).toEqual(["job-1"]);
    expect(released).toEqual([]);
    expect(summary).toEqual({
      claimedCount: 1,
      results: [{ ...job, outcome: "dispatched" }],
    });
  });

  it("releases the lease and reports failure when the publisher throws", async () => {
    const job = fakeJob("job-2");
    const { repository, dispatched, released } = fakeRepository({ claimed: [job] });
    const { publisher } = fakePublisher(() => true);

    const summary = await dispatchProvisioningJobsOnce(repository, publisher, options);

    expect(dispatched).toEqual([]);
    expect(released).toEqual(["job-2"]);
    expect(summary.claimedCount).toBe(1);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({ ...job, outcome: "failed" });
    expect(summary.results[0]?.error).toBeInstanceOf(Error);
  });

  it("processes each claimed job independently, regardless of another job's outcome", async () => {
    const failing = fakeJob("job-fail");
    const succeeding = fakeJob("job-ok");
    const { repository, dispatched } = fakeRepository({ claimed: [failing, succeeding] });
    const { publisher } = fakePublisher((job) => job.id === "job-fail");

    const summary = await dispatchProvisioningJobsOnce(repository, publisher, options);

    expect(dispatched).toEqual(["job-ok"]);
    expect(summary.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "job-fail", outcome: "failed" }),
        expect.objectContaining({ id: "job-ok", outcome: "dispatched" }),
      ]),
    );
  });

  it("still reports the job as failed even if releasing the lease also fails", async () => {
    const job = fakeJob("job-3");
    const { repository, released } = fakeRepository({ claimed: [job], releaseLeaseFails: true });
    const { publisher } = fakePublisher(() => true);

    const summary = await dispatchProvisioningJobsOnce(repository, publisher, options);

    expect(released).toEqual(["job-3"]);
    expect(summary.results[0]).toMatchObject({ ...job, outcome: "failed" });
  });
});
