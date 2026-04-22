/**
 * §10.7.1 subject-scoped privacy state.
 *
 * Tracks two things per-subject across a Runner's lifetime:
 *   1. Whether the subject has been tombstoned under which scope
 *      (memory | audit | session | all) — subsequent resume attempts
 *      and export requests honor these via §10.7.1's redacted-stub
 *      behavior.
 *   2. A small in-process mirror of the subject's memory + audit +
 *      session touchpoints so `privacy.export_subject` can return a
 *      JCS-canonical body without hitting disk.
 *
 * This is an in-memory stand-in for a production subject-access
 * pipeline. For M3 conformance we only need the shape of the export +
 * the presence of SubjectSuppression tombstone records, not a real
 * persisted-store implementation.
 */

export type SubjectScope = "memory" | "audit" | "session" | "all";

export interface SubjectMemoryEntry {
  note_id: string;
  summary: string;
  data_class: string;
  session_id: string;
  written_at: string;
}

export interface SubjectAuditEntry {
  record_id: string;
  this_hash: string;
  decision: string;
  tool: string;
  reason?: string;
  timestamp: string;
}

export interface SubjectSessionEntry {
  session_id: string;
  activeMode: string;
  created_at: string;
  closed_at?: string;
}

export interface SubjectSuppressionRecord {
  subject_id: string;
  scopes: readonly SubjectScope[];
  legal_basis: string;
  operator_kid: string;
  suppressed_at: string;
}

export interface SubjectExport {
  subject_id: string;
  generated_at: string;
  memory: readonly SubjectMemoryEntry[];
  audit: readonly SubjectAuditEntry[];
  sessions: readonly SubjectSessionEntry[];
  suppressions: readonly SubjectSuppressionRecord[];
}

export class InMemorySubjectStore {
  private memory = new Map<string, SubjectMemoryEntry[]>();
  private audit = new Map<string, SubjectAuditEntry[]>();
  private sessions = new Map<string, SubjectSessionEntry[]>();
  private suppressions = new Map<string, SubjectSuppressionRecord[]>();

  recordMemory(subject_id: string, entry: SubjectMemoryEntry): void {
    if (!this.memory.has(subject_id)) this.memory.set(subject_id, []);
    this.memory.get(subject_id)!.push(entry);
  }

  recordAudit(subject_id: string, entry: SubjectAuditEntry): void {
    if (!this.audit.has(subject_id)) this.audit.set(subject_id, []);
    this.audit.get(subject_id)!.push(entry);
  }

  recordSession(subject_id: string, entry: SubjectSessionEntry): void {
    if (!this.sessions.has(subject_id)) this.sessions.set(subject_id, []);
    this.sessions.get(subject_id)!.push(entry);
  }

  recordSuppression(record: SubjectSuppressionRecord): void {
    if (!this.suppressions.has(record.subject_id)) {
      this.suppressions.set(record.subject_id, []);
    }
    this.suppressions.get(record.subject_id)!.push(record);
  }

  /** §10.7.1 export returns JCS-canonical filtered view; suppressed → redacted stubs. */
  export(subject_id: string, generated_at: string): SubjectExport {
    const suppressions = this.suppressions.get(subject_id) ?? [];
    const scopesSuppressed = new Set<SubjectScope>();
    for (const s of suppressions) {
      for (const scope of s.scopes) scopesSuppressed.add(scope);
    }
    const isSuppressed = (scope: SubjectScope) =>
      scopesSuppressed.has("all") || scopesSuppressed.has(scope);

    const memory = (this.memory.get(subject_id) ?? []).map((e) =>
      isSuppressed("memory")
        ? { ...e, summary: "<redacted: §10.7.1 SubjectSuppression>" }
        : e
    );
    const audit = (this.audit.get(subject_id) ?? []).map((e) =>
      isSuppressed("audit")
        ? { ...e, reason: "<redacted: §10.7.1 SubjectSuppression>" }
        : e
    );
    const sessionList = (this.sessions.get(subject_id) ?? []).map((e) =>
      isSuppressed("session")
        ? { ...e, activeMode: "<redacted: §10.7.1 SubjectSuppression>" }
        : e
    );

    return {
      subject_id,
      generated_at,
      memory,
      audit,
      sessions: sessionList,
      suppressions
    };
  }

  /** Tombstone memory/session for subject; audit is §10.5 WORM so suppressed stub only. */
  tombstone(opts: {
    subject_id: string;
    scopes: readonly SubjectScope[];
    legal_basis: string;
    operator_kid: string;
    suppressed_at: string;
  }): SubjectSuppressionRecord {
    const record: SubjectSuppressionRecord = {
      subject_id: opts.subject_id,
      scopes: [...opts.scopes],
      legal_basis: opts.legal_basis,
      operator_kid: opts.operator_kid,
      suppressed_at: opts.suppressed_at
    };
    this.recordSuppression(record);
    return record;
  }

  suppressionsFor(subject_id: string): readonly SubjectSuppressionRecord[] {
    return this.suppressions.get(subject_id) ?? [];
  }
}
