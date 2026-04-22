/**
 * §15 hook reentrancy guard (Finding N / SV-HOOK-08).
 *
 * A PreToolUse or PostToolUse hook process is — by design — an external
 * program the Runner spawns, feeds session context to, and awaits.
 * Nothing in the OS prevents that program from turning around and
 * calling back into /permissions/decisions on the Runner's HTTP
 * surface, which would recursively spawn another hook, which could
 * call back again — a classic reentrancy loop that would either
 * deadlock the decision pipeline or silently escalate permissions via
 * a self-issued PDA-less request.
 *
 * The guard: while a hook child is in flight, its OS-level process id
 * is tracked against its session. Any /permissions/decisions request
 * that identifies itself (via the `x-soa-hook-pid` header, which
 * well-behaved hooks MAY set and conformance hook fixtures MUST set)
 * with a PID in the in-flight set is rejected AND the owning session
 * is terminated with a §14.1 SessionEnd event whose
 * payload.stop_reason = "HookReentrancy". The bearer is revoked so
 * further requests from the misbehaving hook fail at auth.
 *
 * Scope + limits:
 * - The tracker is process-wide (one per Runner). Sessions are
 *   logically partitioned by a Map<sessionId, Set<pid>>; lookups
 *   resolve `pid → sessionId` in O(n_sessions) which is fine at M3
 *   scale (hundreds of concurrent sessions, a handful of in-flight
 *   hooks per session).
 * - The `x-soa-hook-pid` header convention IS the trust boundary.
 *   A malicious hook that omits the header still hits auth / rate
 *   limiting / bracket-persist semantics as a normal external caller,
 *   so reentrancy detection is additive defense-in-depth, not a sole
 *   security mechanism.
 * - PID reuse is a theoretical race — a PID freed between one hook's
 *   exit and the next scan could alias another unrelated process.
 *   The tracker calls `end()` synchronously on `child.on("close")`
 *   and `child.on("error")` so the window is bounded by the
 *   scheduler's delay between those events and the HTTP request
 *   arriving; in practice <1 ms. For M3 conformance we accept this.
 */

export interface HookReentrancyEvent {
  sessionId: string;
  pid: number;
}

export class HookReentrancyTracker {
  private readonly sessionsByPid = new Map<number, string>();
  private readonly pidsBySession = new Map<string, Set<number>>();

  /** Register a freshly-spawned hook child for `sessionId`. */
  begin(sessionId: string, pid: number): void {
    this.sessionsByPid.set(pid, sessionId);
    const set = this.pidsBySession.get(sessionId) ?? new Set<number>();
    set.add(pid);
    this.pidsBySession.set(sessionId, set);
  }

  /** Deregister on hook exit or spawn failure. Safe to call with an unknown pid. */
  end(sessionId: string, pid: number): void {
    this.sessionsByPid.delete(pid);
    const set = this.pidsBySession.get(sessionId);
    if (set) {
      set.delete(pid);
      if (set.size === 0) this.pidsBySession.delete(sessionId);
    }
  }

  /** True when any session has this pid tracked. */
  isInFlight(pid: number): boolean {
    return this.sessionsByPid.has(pid);
  }

  /** Which session owns the in-flight hook with this pid, or null. */
  sessionForPid(pid: number): string | null {
    return this.sessionsByPid.get(pid) ?? null;
  }

  /** Read-only snapshot for diagnostics + tests. */
  snapshot(): readonly HookReentrancyEvent[] {
    const out: HookReentrancyEvent[] = [];
    for (const [pid, sessionId] of this.sessionsByPid.entries()) {
      out.push({ sessionId, pid });
    }
    return out;
  }

  /** True when no hooks are currently tracked. */
  isEmpty(): boolean {
    return this.sessionsByPid.size === 0;
  }
}
