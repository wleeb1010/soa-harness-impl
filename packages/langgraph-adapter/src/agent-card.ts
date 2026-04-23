/**
 * Agent Card helpers — SV-ADAPTER-01.
 *
 * §18.5.1 requires an adapter's Agent Card to declare
 * `adapter_notes.host_framework` as a value from the closed set
 * `{"langgraph", "crewai", "autogen", "langchain-agents", "custom"}`.
 * This adapter always declares `"langgraph"` (matches the HOST_FRAMEWORK
 * constant in index.ts).
 *
 * `buildAdapterCard(base)` takes a user-supplied Card object and
 * overlays the adapter_notes block without perturbing other fields.
 * Kept as a pure function so tests can assert the resulting shape
 * without any HTTP / filesystem coupling.
 */

import { HOST_FRAMEWORK } from "./index.js";

export interface AdapterNotes {
  /** Closed enum per §18.5.1. This adapter always emits "langgraph". */
  host_framework: typeof HOST_FRAMEWORK;
  /** Pre-dispatch interception mode per §18.5.2. Adapter ships "pre-dispatch" (non-advisory). */
  permission_mode: "pre-dispatch" | "advisory";
  /** Adapter package version — for Card consumers to correlate against adapter release. */
  adapter_version: string;
  /** §18.5.4 declared deferrals; empty array means "no documented exceptions". */
  deferred_test_families?: readonly string[];
  /** §18.5.4 item 5 — declared event-mapping deviations from §14.6.1 default. */
  event_mapping_deviations?: ReadonlyArray<{ langgraph_event: string; soa_type: string; rationale: string }>;
}

export interface BuildAdapterCardOptions {
  /** The base Card object. Typically loaded from agent-card.json and validated against `@soa-harness/schemas` first. */
  baseCard: Record<string, unknown>;
  /** Adapter package version (e.g. from this package's ADAPTER_VERSION export). */
  adapterVersion: string;
  /** Permission mode — defaults to "pre-dispatch" since this adapter proves the invariant (Phase 0b + Phase 2 module A). */
  permissionMode?: "pre-dispatch" | "advisory";
  /** Optional: declared deferrals per §18.5.4. */
  deferredTestFamilies?: readonly string[];
  /** Optional: declared event-mapping deviations per §18.5.4 item 5. */
  eventMappingDeviations?: AdapterNotes["event_mapping_deviations"];
}

/**
 * Overlay adapter_notes onto a base Agent Card. Returns a new object;
 * does not mutate the input.
 *
 * SV-ADAPTER-01 conformance: the returned card's
 * `adapter_notes.host_framework` is always `"langgraph"`. A Runner
 * serving this card passes SV-ADAPTER-01 when invoked via
 * `soa-validate --adapter=langgraph`.
 */
export function buildAdapterCard(
  opts: BuildAdapterCardOptions,
): Record<string, unknown> {
  const notes: AdapterNotes = {
    host_framework: HOST_FRAMEWORK,
    permission_mode: opts.permissionMode ?? "pre-dispatch",
    adapter_version: opts.adapterVersion,
    ...(opts.deferredTestFamilies !== undefined
      ? { deferred_test_families: opts.deferredTestFamilies }
      : {}),
    ...(opts.eventMappingDeviations !== undefined
      ? { event_mapping_deviations: opts.eventMappingDeviations }
      : {}),
  };

  return {
    ...opts.baseCard,
    adapter_notes: notes,
  };
}
