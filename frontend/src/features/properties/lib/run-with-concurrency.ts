/**
 * Minimal, dependency-free bounded-concurrency runner (Prompt 041, section 15) — used to upload
 * several files without firing unlimited parallel requests, and without pulling in a queue
 * library for it. `worker` must handle its own errors (never throw) — this task, section 55: a
 * batch is never all-or-nothing, so one item's failure must never abort the others still
 * running. Callers report a failed item through their own state, not by rejecting here.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;

  async function runNext(): Promise<void> {
    const index = cursor++;
    if (index >= items.length) {
      return;
    }

    const item = items[index];
    if (item !== undefined) {
      await worker(item, index);
    }

    return runNext();
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
}
