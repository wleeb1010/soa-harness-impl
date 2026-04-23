/**
 * Runner-backed permission hook — Phase 2 module A.
 *
 * Takes the Phase 0b spike's `PermissionHook` surface (observe + decide)
 * and wires it to a back-end Runner's `POST /permissions/decisions`
 * endpoint per Core §10.3.2. Replaces the hard-coded fixture decisions
 * with a real HTTP round-trip so the adapter-conformance surface
 * (SV-ADAPTER-02) matches the native Runner's permission flow.
 *
 * Safe-defaults: network error, timeout, non-2xx response, or any
 * response `decision` outside `"AutoAllow"` → `"deny"`. Denying-on-fail
 * is the correct safety posture for a permission gate; a network blip
 * never silently admits a tool dispatch.
 *
 * Scope: this module handles the decision round-trip only. It does NOT
 * emit PermissionPrompt / PermissionDecision StreamEvents — that is the
 * orchestrator's job (it has access to the session's event channel and
 * timestamp authority). The hook's `observe()` records (name, args, at)
 * locally so the orchestrator can correlate an emitted PermissionPrompt
 * with the hook invocation that produced it.
 */

import type { PermissionDecision, PermissionHook } from "./types.js";

export interface Observation {
  readonly name: string;
  readonly args: unknown;
  readonly at: bigint;
}

export interface RunnerBackedPermissionHookOptions {
  /** Base URL of the back-end Runner, e.g. "http://localhost:7700". No trailing slash. */
  runnerBaseUrl: string;
  /** Bearer token for `/permissions/decisions`. Can be a static string or an async provider. */
  bearer: string | (() => Promise<string>);
  /** Scope-bound session_id; every decide() call carries this. */
  sessionId: string;
  /** Request timeout in ms. Default 5000 (matches §10.4 Pre/PostToolUse defaults). */
  timeoutMs?: number;
  /** fetch override for tests. Default globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Minimal client-side shape of `POST /permissions/decisions`. Matches
 * the `decision` enum in `schemas/vendored/permission-decision-response.schema.json`
 * at the pinned spec commit.
 */
interface DecisionsResponseBody {
  readonly decision: "AutoAllow" | "Prompt" | "Deny" | "CapabilityDenied" | "ConfigPrecedenceViolation";
}

export class RunnerBackedPermissionHook implements PermissionHook {
  private readonly observations: Observation[] = [];
  private readonly runnerBaseUrl: string;
  private readonly bearer: string | (() => Promise<string>);
  private readonly sessionId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RunnerBackedPermissionHookOptions) {
    if (!opts.runnerBaseUrl) {
      throw new Error("RunnerBackedPermissionHook: runnerBaseUrl is required");
    }
    if (!opts.sessionId) {
      throw new Error("RunnerBackedPermissionHook: sessionId is required");
    }
    this.runnerBaseUrl = opts.runnerBaseUrl.replace(/\/+$/, "");
    this.bearer = opts.bearer;
    this.sessionId = opts.sessionId;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  observe(name: string, args: unknown): void {
    this.observations.push({ name, args, at: process.hrtime.bigint() });
  }

  /**
   * Snapshot of observations recorded by this hook instance. Useful for
   * the orchestrator to synthesize PermissionPrompt StreamEvents with the
   * observed (name, args, at) context, or for tests asserting pre-dispatch
   * order.
   */
  getObservations(): readonly Observation[] {
    return [...this.observations];
  }

  async decide(name: string, args: unknown): Promise<PermissionDecision> {
    let bearer: string;
    try {
      bearer = typeof this.bearer === "function" ? await this.bearer() : this.bearer;
    } catch {
      // A failed bearer provider is a gate failure — deny.
      return "deny";
    }
    if (!bearer) return "deny";

    const body = {
      session_id: this.sessionId,
      tool_name: name,
      args,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await this.fetchImpl(`${this.runnerBaseUrl}/permissions/decisions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "authorization": `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        // 4xx/5xx from the Runner → deny. Don't interpret unknown statuses
        // as anything other than "gate rejected the request."
        return "deny";
      }

      let parsed: unknown;
      try {
        parsed = await resp.json();
      } catch {
        return "deny";
      }

      const decision = (parsed as DecisionsResponseBody).decision;
      // Only "AutoAllow" unambiguously authorizes dispatch. "Prompt" means
      // the Runner needs HITL — Phase 2 treats this as "deny" until the
      // adapter wires a human-in-the-loop responder (Phase 3+).
      return decision === "AutoAllow" ? "allow" : "deny";
    } catch {
      // Abort (timeout), network error, DNS failure, TLS failure, etc.
      return "deny";
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/** Factory — lightly more ergonomic than `new RunnerBackedPermissionHook(...)`. */
export function createRunnerBackedPermissionHook(
  opts: RunnerBackedPermissionHookOptions,
): RunnerBackedPermissionHook {
  return new RunnerBackedPermissionHook(opts);
}
