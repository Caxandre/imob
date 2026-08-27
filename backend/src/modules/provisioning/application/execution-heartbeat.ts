export interface ExecutionHeartbeatRepository {
  /**
   * Renews the execution lease for `id`, only if `executionToken` still owns it. Returns
   * `false` when the write matched no row — the lease already expired and another execution
   * claimed it (ownership lost), so the caller must stop renewing.
   */
  renewExecutionLease(id: string, executionToken: string, leaseSeconds: number): Promise<boolean>;
}

export type ExecutionHeartbeatEvent =
  | { type: "renewed" }
  | { type: "ownership-lost" }
  | { type: "renewal-error"; error: unknown };

export interface ExecutionHeartbeat {
  stop(): void;
}

/**
 * Periodically renews a `RUNNING` provisioning job's execution lease while work is in
 * progress (ADR-003 "Recovery") — a completely separate mechanism from the dispatcher's own
 * lease (ADR-002), never sharing state with it. Deliberately infra-free: no logger, no Pino —
 * observability is the caller's responsibility via the optional `onEvent` callback, kept as a
 * plain function so this module never depends on how (or whether) events get logged.
 *
 * A single transient renewal failure does not stop the heartbeat (section 23: the lease may
 * still be valid, and the next tick tries again normally) — only an explicit loss of
 * ownership (a renewal that matched no row) does, since renewing further would be pointless
 * and could race with whatever execution now legitimately owns the job.
 */
export function startExecutionHeartbeat(
  repository: ExecutionHeartbeatRepository,
  claim: { id: string; executionToken: string },
  options: { leaseSeconds: number; intervalMs: number; onEvent?: (event: ExecutionHeartbeatEvent) => void },
): ExecutionHeartbeat {
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) {
      return;
    }
    try {
      const stillOwned = await repository.renewExecutionLease(claim.id, claim.executionToken, options.leaseSeconds);
      if (!stillOwned) {
        options.onEvent?.({ type: "ownership-lost" });
        stop();
        return;
      }
      options.onEvent?.({ type: "renewed" });
    } catch (error) {
      options.onEvent?.({ type: "renewal-error", error });
    }
  }

  const timer = setInterval(() => void tick(), options.intervalMs);
  // Never let this timer alone keep the Node process alive — the caller's own workload
  // (provision()/finalizeProvisioning()) already does, and `stop()` always runs in `finally`.
  timer.unref?.();

  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  }

  return { stop };
}
