/**
 * §17.2.3 A2A capability advertisement and matching.
 *
 * Normative truth table (v1.3):
 *
 * | Receiver A2A state             | capabilities_needed      | Response                                               |
 * |--------------------------------|--------------------------|--------------------------------------------------------|
 * | Serves none (absent / [])      | empty []                 | {accept:true}                                          |
 * | Serves none (absent / [])      | non-empty                | {accept:false, reason:"no-a2a-capabilities-advertised"}|
 * | Serves set S (non-empty)       | empty []                 | {accept:true}                                          |
 * | Serves set S (non-empty)       | non-empty, ⊆ S           | {accept:true}  (MAY reject for non-capability reason)  |
 * | Serves set S (non-empty)       | non-empty, ⊄ S           | -32003 CapabilityMismatch, error.data.missing_capabilities |
 *
 * Three encodings of "serves no A2A capabilities" are semantically identical:
 * (a) a2a absent, (b) a2a.capabilities absent, (c) a2a.capabilities === [].
 *
 * Comparison is byte-exact over UTF-8. NO Unicode normalization, case folding,
 * whitespace trimming, or any other transformation is applied.
 *
 * Pre-match validation of capabilities_needed (§17.2.3 "capabilities_needed
 * validation"):
 * - Each entry MUST be a non-empty string; empty strings → HandoffRejected
 *   (reason=wire-incompatibility).
 * - Duplicates deduplicated order-preserving on first occurrence; this
 *   MUST NOT be observable as a rejection.
 * - length > 256 MAY return HandoffRejected(reason=wire-incompatibility) as
 *   a soft DoS cap. We enforce this cap (callers can reasonably stay well
 *   below 256 distinct capability tokens per request).
 */

/**
 * §17.2.3 soft cap on `capabilities_needed.length`. Receivers MAY reject
 * requests exceeding this with HandoffRejected(reason=wire-incompatibility).
 */
export const A2A_CAPABILITIES_NEEDED_SOFT_CAP = 256;

/**
 * Outcome of running the §17.2.3 truth table. Discriminated union so callers
 * (the `handoff.offer` handler) can switch exhaustively without re-implementing
 * the rules.
 */
export type A2aCapabilityMatchOutcome =
  | { kind: "accept" }
  /** Row 2: {accept:false, reason:"no-a2a-capabilities-advertised"}. */
  | { kind: "reject-no-capabilities" }
  /** Caller sent malformed input — HandoffRejected(reason=wire-incompatibility). */
  | { kind: "wire-incompatible"; detail: string }
  /** Row 5: -32003 CapabilityMismatch with error.data.missing_capabilities. */
  | { kind: "capability-mismatch"; missing: string[] };

/**
 * Apply the §17.2.3 truth table + validation rules. Pure function — no
 * exceptions thrown; wire-layer concerns (JSON-RPC framing, error shape)
 * are the caller's job.
 *
 * @param capabilitiesNeeded — raw value from JSON-RPC params; may be any
 *   shape (validation happens here).
 * @param a2aCapabilities — the receiver's own Agent Card `a2a.capabilities`
 *   value. Undefined means the `a2a` object OR the `capabilities` field is
 *   absent; an empty array is semantically identical per §17.2.3.
 */
export function matchA2aCapabilities(
  capabilitiesNeeded: unknown,
  a2aCapabilities: string[] | undefined,
): A2aCapabilityMatchOutcome {
  if (!Array.isArray(capabilitiesNeeded)) {
    return {
      kind: "wire-incompatible",
      detail: "capabilities_needed missing or not an array",
    };
  }
  if (capabilitiesNeeded.length > A2A_CAPABILITIES_NEEDED_SOFT_CAP) {
    return {
      kind: "wire-incompatible",
      detail: `capabilities_needed.length ${capabilitiesNeeded.length} exceeds soft cap ${A2A_CAPABILITIES_NEEDED_SOFT_CAP}`,
    };
  }

  // Per-entry validation + order-preserving dedup.
  const seen = new Set<string>();
  const needed: string[] = [];
  for (const entry of capabilitiesNeeded) {
    if (typeof entry !== "string" || entry.length === 0) {
      return {
        kind: "wire-incompatible",
        detail: "capabilities_needed entries MUST be non-empty strings",
      };
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    needed.push(entry);
  }

  // "Serves none" covers: undefined (a2a absent or a2a.capabilities absent)
  // AND explicit empty array. §17.2.3: the three encodings are semantically
  // identical.
  const servesNone = a2aCapabilities === undefined || a2aCapabilities.length === 0;

  // Row 1 + Row 3: empty needed → accept on capability grounds regardless.
  if (needed.length === 0) {
    return { kind: "accept" };
  }
  // Row 2: non-empty needed vs serves-none.
  if (servesNone) {
    return { kind: "reject-no-capabilities" };
  }
  // Rows 4 + 5: non-empty needed vs set S.
  const servedSet = new Set(a2aCapabilities);
  const missing: string[] = [];
  for (const tok of needed) {
    if (!servedSet.has(tok)) missing.push(tok);
  }
  return missing.length === 0 ? { kind: "accept" } : { kind: "capability-mismatch", missing };
}
