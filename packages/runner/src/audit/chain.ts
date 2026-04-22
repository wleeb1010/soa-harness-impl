import { createHash } from "node:crypto";
import { jcs } from "@soa-harness/core";
import type { Clock } from "../clock/index.js";
import { NOOP_EMITTER, type MarkerEmitter } from "../markers/index.js";

export const GENESIS = "GENESIS" as const;

/**
 * §10.5.5 L-48 Finding BC — WORM sink model. When enabled, each
 * appended record is stamped with `sink_timestamp` (distinct field
 * from Runner-internal `timestamp`) and the §10.5.1 mutation/delete
 * endpoints reject with 405 ImmutableAuditSink. Hash-chain
 * participation matches L-40 billing_tag: canonical-JCS-serialized
 * when present, absent when not — no empty-string placeholder.
 */
export type AuditSinkMode = "worm-in-memory";

export interface AuditRecordCore {
  timestamp: string;
  prev_hash: string;
  this_hash: string;
}

/**
 * Hash-chained audit record. For M1 we keep the structural minimum — later
 * milestones extend with the full §10.5 record body (subject_id, decision,
 * args_digest, handler_kid, etc.). The chain invariant is:
 *
 *   this_hash = SHA-256(prev_hash || canonical_json_of_record_without_this_hash)
 *
 * where canonical_json is §1 JCS of the record with `this_hash` removed.
 * First record's prev_hash is the literal "GENESIS".
 */
export interface AuditRecord extends AuditRecordCore {
  [extraField: string]: unknown;
}

function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Minimal in-memory audit chain that backs /audit/tail. Real persistence to
 * `/audit/permissions.log` + WAL + external WORM sink lands in M2 per §10.5 +
 * §10.5.1. The tail-read surface is defined independently of persistence —
 * §10.5.2 only requires that a reader observes the authoritative tail state
 * WITHOUT producing a meta-record, and that the body's `this_hash` matches
 * the chain invariant.
 */
export class AuditChain {
  private readonly records: AuditRecord[] = [];
  private tail: string = GENESIS;
  private readonly markers: MarkerEmitter;
  private readonly sinkMode: AuditSinkMode | null;

  constructor(
    private readonly now: Clock,
    opts?: { markers?: MarkerEmitter; sinkMode?: AuditSinkMode }
  ) {
    this.markers = opts?.markers ?? NOOP_EMITTER;
    this.sinkMode = opts?.sinkMode ?? null;
  }

  /** Is this chain backed by a WORM sink model? (§10.5.5 Finding BC.) */
  isWormSink(): boolean {
    return this.sinkMode === "worm-in-memory";
  }

  /** Append an arbitrary record body; the chain fills in timestamp + prev_hash + this_hash. */
  append(body: Record<string, unknown>): AuditRecord {
    const timestamp = this.now().toISOString();
    const prev_hash = this.tail;
    const draft: AuditRecord = { ...body, timestamp, prev_hash, this_hash: "" };
    // §10.5.5 Finding BC — stamp sink_timestamp when WORM model is
    // attached. Same clock call as `timestamp` so |sink_timestamp −
    // timestamp| = 0 in-process (≤1s per spec). Only stamped when the
    // field is absent in the inbound body so callers can override for
    // replay scenarios (audit-sink flush reuses original sink_timestamp).
    if (this.sinkMode === "worm-in-memory" && draft["sink_timestamp"] === undefined) {
      draft["sink_timestamp"] = timestamp;
    }
    // Canonical form is the full record minus the this_hash placeholder.
    const withoutHash = { ...draft } as Record<string, unknown>;
    delete withoutHash["this_hash"];
    const this_hash = sha256Hex(Buffer.concat([Buffer.from(prev_hash, "utf8"), Buffer.from(jcs(withoutHash), "utf8")]));
    draft.this_hash = this_hash;
    this.records.push(draft);
    this.tail = this_hash;

    // §12.5.3 — SOA_MARK_AUDIT_APPEND_DONE fires after the hash-chain commit.
    // (In M2 the chain is in-memory; per-record fsync is M3 scope. The marker
    // still names the logical append boundary so crash-kill harnesses can
    // target it once persistence lands.)
    const recordId = typeof draft["id"] === "string" ? (draft["id"] as string) : draft.this_hash;
    this.markers.auditAppendDone(recordId);
    return draft;
  }

  tailHash(): string {
    return this.tail;
  }

  recordCount(): number {
    return this.records.length;
  }

  lastRecordTimestamp(): string | undefined {
    return this.records.at(-1)?.timestamp;
  }

  /** Test / operator-tool helper. Reading the chain MUST NOT mutate it. */
  snapshot(): readonly AuditRecord[] {
    return this.records.slice();
  }
}
