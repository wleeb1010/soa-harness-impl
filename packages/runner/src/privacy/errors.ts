/**
 * §24 closed error taxonomy entries required by §10.7 SV-PRIV block.
 * The Runner raises these as typed errors so the decisions and
 * consolidation paths can branch on `instanceof` rather than
 * stringifying error messages.
 */

/** §10.7 #2 — consolidation of a sensitive-personal memory entry. */
export class MemoryDeletionForbidden extends Error {
  readonly reason: "sensitive-class-forbidden" | "tombstone-integrity-required";
  readonly note_id: string | undefined;
  readonly session_id: string | undefined;
  constructor(opts: {
    reason: MemoryDeletionForbidden["reason"];
    message?: string;
    note_id?: string;
    session_id?: string;
  }) {
    super(opts.message ?? `MemoryDeletionForbidden: ${opts.reason}`);
    this.name = "MemoryDeletionForbidden";
    this.reason = opts.reason;
    this.note_id = opts.note_id;
    this.session_id = opts.session_id;
  }
}

/** §10.7.2 — residency gate denial raised from the decisions path. */
export class ResidencyViolation extends Error {
  readonly reason: "residency-violation";
  readonly sub_reason:
    | "tool-declaration-mismatch"
    | "attestation-mismatch"
    | "unknown-region";
  readonly tool: string;
  readonly declared_location: readonly string[] | undefined;
  readonly attested_location: readonly string[] | undefined;
  readonly network_signal_regions: readonly string[] | undefined;
  readonly data_residency: readonly string[];
  constructor(opts: {
    sub_reason: ResidencyViolation["sub_reason"];
    tool: string;
    data_residency: readonly string[];
    declared_location?: readonly string[];
    attested_location?: readonly string[];
    network_signal_regions?: readonly string[];
  }) {
    super(
      `ResidencyViolation(${opts.sub_reason}): tool=${opts.tool} ` +
        `declared=${JSON.stringify(opts.declared_location ?? [])} ` +
        `attested=${JSON.stringify(opts.attested_location ?? [])} ` +
        `residency=${JSON.stringify([...opts.data_residency])}`
    );
    this.name = "ResidencyViolation";
    this.reason = "residency-violation";
    this.sub_reason = opts.sub_reason;
    this.tool = opts.tool;
    this.declared_location = opts.declared_location;
    this.attested_location = opts.attested_location;
    this.network_signal_regions = opts.network_signal_regions;
    this.data_residency = opts.data_residency;
  }
}
