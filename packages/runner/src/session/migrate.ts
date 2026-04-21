import type { Capability } from "../permission/types.js";

/**
 * Shape of a §12.1 session-file record as persisted to disk. Pre-1.0 (L-20
 * drift) session files MAY lack `activeMode`; the refresh at spec commit
 * 80680cd made it required. The runtime migration path here defaults a
 * missing `activeMode` to the Agent Card's `permissions.activeMode` so
 * existing on-disk sessions resume cleanly; the post-1.0 on-disk format
 * MUST carry the field explicitly.
 */
export interface PersistedSession {
  session_id: string;
  format_version: "1.0";
  activeMode?: Capability;
  messages?: unknown[];
  workflow?: unknown;
  counters?: unknown;
  tool_pool_hash?: string;
  card_version?: string;
  [extraField: string]: unknown;
}

export interface MigratedSession extends PersistedSession {
  activeMode: Capability;
  _migrated?: { from: "pre-1.0" };
}

/**
 * Resume-time migration for pre-1.0 session files that predate the L-20 /
 * §12.1 activeMode-required refresh. When `activeMode` is absent on disk,
 * default it to the Agent Card's `permissions.activeMode`. The migrated
 * session carries a `_migrated` marker so an operator sees the upgrade
 * in the reloaded state.
 *
 * Callers MUST persist the migrated session back to disk so the pre-1.0
 * state doesn't resurface on a subsequent load — but persisting is outside
 * this helper's scope (it's a pure function).
 */
export function migratePre1SessionFile(
  file: PersistedSession,
  cardActiveMode: Capability
): MigratedSession {
  if (typeof file.activeMode === "string") {
    return file as MigratedSession;
  }
  return { ...file, activeMode: cardActiveMode, _migrated: { from: "pre-1.0" } };
}
