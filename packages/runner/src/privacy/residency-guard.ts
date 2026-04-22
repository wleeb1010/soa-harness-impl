/**
 * §10.7.2 Residency layered-defence primitive.
 *
 * Pure function: caller passes the Agent Card's `security.data_residency`
 * pin + the tool's declared + attested locations + any corroborating
 * network signals; the guard returns either `allow` or `deny` with a
 * ResidencyViolation payload carrying all four layers so the audit
 * record (required by §10.7.2 #4) can include the full decision trail.
 *
 * Empty or unset `data_residency` = "no residency constraint" (spec
 * §10.7.2 closing paragraph). The guard returns allow with an empty
 * layered-payload so the caller can still emit a residency audit row
 * for traceability if desired.
 *
 * Tools without a declared `data_processing_location` manifest field
 * are treated as region `"*"` (unknown) and rejected by any deployment
 * with a non-empty residency pin — this is the §10.7.2 explicit
 * behavior for tools that fail to declare.
 */

import { ResidencyViolation } from "./errors.js";

export interface ResidencyDecisionInput {
  tool: string;
  data_residency: readonly string[];
  declared_location?: readonly string[];
  attested_location?: readonly string[];
  network_signal_regions?: readonly string[];
}

export interface ResidencyDecisionAllow {
  outcome: "allow";
  tool: string;
  data_residency: readonly string[];
  declared_location: readonly string[];
  attested_location: readonly string[] | undefined;
  network_signal_regions: readonly string[] | undefined;
}

export interface ResidencyDecisionDeny {
  outcome: "deny";
  error: ResidencyViolation;
}

export type ResidencyDecision = ResidencyDecisionAllow | ResidencyDecisionDeny;

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const bs = new Set(b);
  return a.filter((x) => bs.has(x));
}

export function residencyDecision(input: ResidencyDecisionInput): ResidencyDecision {
  const {
    tool,
    data_residency,
    declared_location,
    attested_location,
    network_signal_regions
  } = input;

  // Empty/unset pin = no constraint.
  if (data_residency.length === 0) {
    return {
      outcome: "allow",
      tool,
      data_residency,
      declared_location: declared_location ?? [],
      attested_location,
      network_signal_regions
    };
  }

  // Tool didn't declare a processing location — region "*" (unknown).
  // §10.7.2 primary-signal requirement → reject.
  if (declared_location === undefined || declared_location.length === 0) {
    return {
      outcome: "deny",
      error: new ResidencyViolation({
        sub_reason: "unknown-region",
        tool,
        data_residency,
        ...(attested_location !== undefined ? { attested_location } : {}),
        ...(network_signal_regions !== undefined ? { network_signal_regions } : {})
      })
    };
  }

  // Primary signal — tool-declared location must intersect the pin.
  const declaredIntersect = intersect(declared_location, data_residency);
  if (declaredIntersect.length === 0) {
    return {
      outcome: "deny",
      error: new ResidencyViolation({
        sub_reason: "tool-declaration-mismatch",
        tool,
        data_residency,
        declared_location,
        ...(attested_location !== undefined ? { attested_location } : {}),
        ...(network_signal_regions !== undefined ? { network_signal_regions } : {})
      })
    };
  }

  // Cryptographic attestation (when available) must match the declaration.
  if (attested_location !== undefined && attested_location.length > 0) {
    const attestedIntersect = intersect(attested_location, declared_location);
    if (attestedIntersect.length === 0) {
      return {
        outcome: "deny",
        error: new ResidencyViolation({
          sub_reason: "attestation-mismatch",
          tool,
          data_residency,
          declared_location,
          attested_location,
          ...(network_signal_regions !== undefined ? { network_signal_regions } : {})
        })
      };
    }
  }

  // Network signals are supporting evidence only — never authoritative
  // per §10.7.2. A deployment relying solely on network signals is
  // explicitly non-conformant. We record them in the audit payload but
  // do not gate on them.
  return {
    outcome: "allow",
    tool,
    data_residency,
    declared_location,
    attested_location,
    network_signal_regions
  };
}

/**
 * Summarise a residency decision as a JSON-ready audit-record payload
 * per §10.7.2 #4 (declared_location, attested_location,
 * network_signal_regions, decision).
 */
export function residencyAuditPayload(decision: ResidencyDecision): {
  tool: string;
  declared_location: readonly string[];
  attested_location: readonly string[];
  network_signal_regions: readonly string[];
  decision: "allow" | "deny";
  sub_reason?: ResidencyViolation["sub_reason"];
} {
  if (decision.outcome === "allow") {
    return {
      tool: decision.tool,
      declared_location: decision.declared_location,
      attested_location: decision.attested_location ?? [],
      network_signal_regions: decision.network_signal_regions ?? [],
      decision: "allow"
    };
  }
  return {
    tool: decision.error.tool,
    declared_location: decision.error.declared_location ?? [],
    attested_location: decision.error.attested_location ?? [],
    network_signal_regions: decision.error.network_signal_regions ?? [],
    decision: "deny",
    sub_reason: decision.error.sub_reason
  };
}
