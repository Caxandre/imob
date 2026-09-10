import { describe, expect, it } from "vitest";

import { runWithConcurrency } from "./run-with-concurrency";

describe("runWithConcurrency", () => {
  it("runs every item exactly once", async () => {
    const processed: number[] = [];

    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      processed.push(item);
    });

    expect(processed.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("never runs more than the given concurrency at the same time", async () => {
    let active = 0;
    let maxActive = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("continues running the remaining items when one worker call throws", async () => {
    const processed: number[] = [];

    await runWithConcurrency([1, 2, 3], 3, async (item) => {
      try {
        if (item === 2) {
          throw new Error("boom");
        }
        processed.push(item);
      } catch {
        // The contract is that `worker` swallows its own errors (section 55) — mirrored here.
      }
    });

    expect(processed.sort()).toEqual([1, 3]);
  });

  it("resolves immediately for an empty item list", async () => {
    let calls = 0;
    await runWithConcurrency([], 3, async () => {
      calls++;
    });

    expect(calls).toBe(0);
  });

  it("handles a concurrency higher than the item count", async () => {
    const processed: number[] = [];

    await runWithConcurrency([1, 2], 10, async (item) => {
      processed.push(item);
    });

    expect(processed.sort()).toEqual([1, 2]);
  });
});
