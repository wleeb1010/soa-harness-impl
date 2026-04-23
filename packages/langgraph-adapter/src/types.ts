/**
 * Shared types for the SOA-Harness LangGraph adapter.
 *
 * Intentionally minimal at Phase 1 scaffold — only the surface area
 * needed by compliance-wrapper (the pre-dispatch interception core)
 * lives here. Full types for permission-hook, stream-event-synth, and
 * audit-sink ship in Phase 2.
 */

/**
 * Decision returned by a permission hook. Mirrors §10.3 semantics:
 * `"allow"` → proceed with dispatch, `"deny"` → skip dispatch and
 * synthesize a denial. `"prompt"` (§10.4 escalation) is a Phase 2
 * concern and deliberately not modeled here yet.
 */
export type PermissionDecision = "allow" | "deny";

/**
 * A pre-dispatch permission hook. `observe` runs synchronously before
 * `decide` so the caller can record (name, args) for §14.1.1
 * PermissionPrompt StreamEvent emission even if the decision takes a
 * round-trip to fetch.
 *
 * Production implementations (Phase 2) back this with an HTTP call to
 * the Runner's `POST /permissions/decisions` endpoint; the spike
 * fixture uses a hard-coded decision for verification.
 */
export interface PermissionHook {
  observe(name: string, args: unknown): void;
  decide(name: string, args: unknown): Promise<PermissionDecision>;
}
