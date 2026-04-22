/**
 * §10.7 SV-PRIV-02 / Finding AG — MemoryDeletionForbidden system-log
 * emission.
 *
 * Shared helper used by every code path that encounters a
 * `sensitive-personal`-tagged memory note. Emits a §14.2 System Event
 * Log record with:
 *
 *   category: Error
 *   level:    error
 *   code:     MemoryDeletionForbidden
 *   data:     { reason: "sensitive-class-forbidden", note_id? }
 *
 * Validators observe the emission via GET /logs/system/recent with
 * category=Error filter (and session_id scope-bound to the bearer).
 */

import type { SystemLogBuffer } from "../system-log/index.js";

export interface SensitivePersonalIncident {
  note_id: string;
  /** Optional summary — omitted from the log message when unsafe to surface. */
  summary?: string;
}

export function emitMemoryDeletionForbidden(
  systemLog: SystemLogBuffer,
  session_id: string,
  incident: SensitivePersonalIncident
): void {
  systemLog.write({
    session_id,
    category: "Error",
    level: "error",
    code: "MemoryDeletionForbidden",
    message:
      `note ${incident.note_id} tagged data_class=sensitive-personal — ` +
      "§10.7 #2 forbids persistence; dropping before recordLoad",
    data: {
      reason: "sensitive-class-forbidden",
      note_id: incident.note_id
    }
  });
}

/**
 * Partition a candidate-note set into `{ safe, forbidden }`. Each
 * forbidden entry triggers a `MemoryDeletionForbidden` system-log
 * emission (when a buffer is supplied). Callers pass the `safe` slice
 * to `memoryStore.recordLoad` so the sensitive-personal entries never
 * reach in-context state.
 */
export function partitionSensitivePersonal<
  N extends { note_id: string; data_class: string }
>(
  notes: readonly N[],
  session_id: string,
  systemLog?: SystemLogBuffer
): { safe: N[]; forbidden: N[] } {
  const safe: N[] = [];
  const forbidden: N[] = [];
  for (const n of notes) {
    if (n.data_class === "sensitive-personal") {
      forbidden.push(n);
      if (systemLog) {
        emitMemoryDeletionForbidden(systemLog, session_id, { note_id: n.note_id });
      }
    } else {
      safe.push(n);
    }
  }
  return { safe, forbidden };
}
