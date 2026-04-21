import { CAPABILITY_PERMITS, isControlTighteningOrEqual, type Capability } from "./types.js";
import type { Control, ToolEntry } from "../registry/types.js";

export type QueryDecision =
  | "AutoAllow"
  | "Prompt"
  | "Deny"
  | "CapabilityDenied"
  | "ConfigPrecedenceViolation";

export type TraceResult = "passed" | "tightened" | "rejected" | "skipped";

export interface TraceEntry {
  step: 1 | 2 | 3 | 4 | 5;
  result: TraceResult;
  detail: string;
}

export interface PermissionsResolveResponse {
  decision: QueryDecision;
  resolved_control: Control;
  resolved_capability: Capability;
  reason: string;
  trace: TraceEntry[];
  resolved_at: string;
  runner_version: string;
  policy_endpoint_applied?: boolean;
}

export interface ResolveForQueryOptions {
  tool: ToolEntry;
  capability: Capability;
  toolRequirement?: Control;
  /** If set, step 4 records "skipped — not implemented in M1"; MAY actually invoke in later milestones. */
  policyEndpoint?: string;
  now: () => Date;
  runnerVersion: string;
}

/**
 * Implements Core §10.3 steps 1–4 without dispatch (no step 5). This is the
 * computation behind /permissions/resolve (Core §10.3.1). The caller is
 * responsible for:
 *   - auth (session-scoped bearer per §10.3.1)
 *   - rate limiting (60 req/min per bearer)
 *   - readiness gating (503 when /ready is 503)
 *   - ensuring the request produces no side effects (§10.3.1 MUST list)
 */
export function resolvePermissionForQuery(opts: ResolveForQueryOptions): PermissionsResolveResponse {
  const trace: TraceEntry[] = [];
  let resolved_control: Control = opts.tool.default_control;

  // Step 1
  trace.push({
    step: 1,
    result: "passed",
    detail: `start: capability=${opts.capability}, tool=${opts.tool.name}, default_control=${resolved_control}`
  });

  // Step 2: capability gate
  const permitted = CAPABILITY_PERMITS[opts.capability];
  if (!permitted.includes(opts.tool.risk_class)) {
    trace.push({
      step: 2,
      result: "rejected",
      detail: `risk_class=${opts.tool.risk_class} not permitted under capability=${opts.capability}`
    });
    return {
      decision: "CapabilityDenied",
      resolved_control,
      resolved_capability: opts.capability,
      reason: "risk-class-not-permitted-under-capability",
      trace,
      resolved_at: opts.now().toISOString(),
      runner_version: opts.runnerVersion
    };
  }
  trace.push({
    step: 2,
    result: "passed",
    detail: `risk_class=${opts.tool.risk_class} permitted under capability=${opts.capability}`
  });

  // Step 3: tighten-only override
  if (opts.toolRequirement !== undefined) {
    if (!isControlTighteningOrEqual(resolved_control, opts.toolRequirement)) {
      trace.push({
        step: 3,
        result: "rejected",
        detail: `toolRequirements=${opts.toolRequirement} loosens registry default=${resolved_control}`
      });
      return {
        decision: "ConfigPrecedenceViolation",
        resolved_control,
        resolved_capability: opts.capability,
        reason: "toolRequirements-loosens-default",
        trace,
        resolved_at: opts.now().toISOString(),
        runner_version: opts.runnerVersion
      };
    }
    if (resolved_control === opts.toolRequirement) {
      trace.push({
        step: 3,
        result: "passed",
        detail: `toolRequirements=${opts.toolRequirement} equals default (no tightening)`
      });
    } else {
      trace.push({
        step: 3,
        result: "tightened",
        detail: `default=${resolved_control} tightened to toolRequirements=${opts.toolRequirement}`
      });
      resolved_control = opts.toolRequirement;
    }
  } else {
    trace.push({ step: 3, result: "skipped", detail: "no toolRequirements override for this tool" });
  }

  // Step 4: policyEndpoint (M1 does NOT invoke — records "skipped" with rationale).
  // The §10.3.1 response MAY carry policy_endpoint_applied:false in both branches;
  // we set it to false when configured so validators can see the Runner is aware
  // of the endpoint but hasn't invoked it this milestone.
  let policy_endpoint_applied: boolean | undefined;
  if (opts.policyEndpoint !== undefined) {
    trace.push({
      step: 4,
      result: "skipped",
      detail: `policyEndpoint configured (${opts.policyEndpoint}) but not invoked in M1 — /permissions/resolve query is idempotent and does not reach the external policy service this milestone`
    });
    policy_endpoint_applied = false;
  } else {
    trace.push({ step: 4, result: "skipped", detail: "policyEndpoint unconfigured on Agent Card" });
  }

  // Terminal decision (step 5 dispatch is NOT performed here).
  let decision: QueryDecision;
  let reason: string;
  if (resolved_control === "AutoAllow") {
    decision = "AutoAllow";
    reason = "auto-allow-under-capability";
  } else if (resolved_control === "Prompt") {
    decision = "Prompt";
    reason = "prompt-required-by-control";
  } else {
    decision = "Deny";
    reason = "deny-by-control";
  }

  const base: PermissionsResolveResponse = {
    decision,
    resolved_control,
    resolved_capability: opts.capability,
    reason,
    trace,
    resolved_at: opts.now().toISOString(),
    runner_version: opts.runnerVersion
  };
  return policy_endpoint_applied !== undefined ? { ...base, policy_endpoint_applied } : base;
}
