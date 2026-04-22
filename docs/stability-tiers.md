# Stability Tiers — SOA-Harness Reference Implementation

Required by Core §19.3. Declares, per-field, the spec stability tier
of every normative surface this reference implementation exposes.

**Default.** Every field and MCP tool signature is **Stable** unless
explicitly listed below. Stable fields are removed only in a major
version bump (Core §19.4 SemVer).

## Tier definitions (§19.3)

| Tier | Lifetime guarantee | Change channel |
|---|---|---|
| `Stable` | Removed only in a major version bump | §19.4 SemVer, §19.5 deprecation (≥ 2 minor releases) |
| `Provisional` | MAY change in a minor version | Change MUST be called out in `migrations/1.x-to-1.y.md` |
| `Experimental` | MAY change in any release | Opt-in via explicit flag |

At v1.0 the reference implementation declares no Experimental fields
and no Provisional fields. Any future minor bump introducing a
Provisional or Experimental tier MUST append an entry to the table
below and a matching row to the migration guide for that minor.

## Tier assignments

| Surface | Field / Tool | Tier | Since | Notes |
|---|---|---|---|---|
| Agent Card (§6) | `soaHarnessVersion` | Stable | 1.0 | `const: "1.0"` for this major |
| Agent Card (§6) | `supported_core_versions` | Stable | 1.0 | Wire-level negotiation advertisement per §19.4.1 |
| Agent Card (§6) | `permissions.activeMode` | Stable | 1.0 | Enum `{ReadOnly, WorkspaceWrite, DangerFullAccess}` |
| Agent Card (§6) | `tokenBudget.billingTag` | Stable | 1.0 | §7 line 1821 residency binding; §10.5 audit row field |
| Agent Card (§6) | `memory.sharing_policy` | Stable | 1.0 | Renamed from `default_sharing_scope` pre-1.0 per §7.318 |
| Memory (§8) | `notes[*].data_class` | Stable | 1.0 | Closed enum `{public, internal, confidential, personal, sensitive-personal}` (§10.7 #2) |
| Audit (§10.5) | `subject_id` | Stable | 1.0 | Part of hash-chained body per §10.5 |
| Audit (§10.5) | `billing_tag` | Stable | 1.0 | Optional per L-40; conditional-absent when session omits |
| Permission Decisions (§10.3.2) | `POST /permissions/decisions` | Stable | 1.0 | |
| Session Bootstrap (§12.6) | `POST /sessions` | Stable | 1.0 | |
| Session Bootstrap (§12.6) | `billing_tag` request body | Stable | 1.0 | §7 line 1821 residency binding |
| Sessions State (§12.5.1) | `GET /sessions/:id/state` | Stable | 1.0 | |
| Observability (§14.5.2) | `GET /observability/otel-spans/recent` | Stable | 1.0 | |
| Observability (§14.5.3) | `GET /observability/backpressure` | Stable | 1.0 | |
| System Event Log (§14.5.4) | `GET /logs/system/recent` | Stable | 1.0 | Closed 12-category enum |
| Budget (§13.5) | `GET /budget/projection` | Stable | 1.0 | `cache_accounting` payload per §13.3 |
| Tools Registry (§11.4) | `GET /tools/registered` | Stable | 1.0 | |
| Privacy (§10.7.1) | `privacy.delete_subject` | Stable | 1.0 | Tool signature: `{subject_id, scope, legal_basis, operator_kid}` |
| Privacy (§10.7.1) | `privacy.export_subject` | Stable | 1.0 | Tool signature: `{subject_id}` → JCS object |
| Governance (§19.4.1) | `POST /sessions` optional `supported_core_versions` | Stable | 1.0 | Empty-intersection → `VersionNegotiationFailed` |
| Governance (§19.4.1) | `GET /version` | Stable | 1.0 | Runner's `soaHarnessVersion` + `supported_core_versions` advertisement |

## Test-only hooks (non-normative surface)

Per Core §11.2.1 / §11.3.1 / §10.6.1 / §12.5.2 / §12.5.3 / §8.4.1 /
SV-BUD-04 the following env vars are test-only and MUST NOT bind
on a non-loopback interface:

| Env var | Section | Purpose |
|---|---|---|
| `RUNNER_TEST_CLOCK` | §10.6.1 | Reference clock injection for CRL freshness tests |
| `RUNNER_CRASH_TEST_MARKERS` | §12.5.3 | 7-marker stderr emission for crash-recovery probes |
| `SOA_RUNNER_BOOTSTRAP_BEARER` | §12.6 | Fixed bootstrap bearer for local-only test deployments |
| `SOA_RUNNER_DYNAMIC_TOOL_REGISTRATION` | §11.3.1 | Trigger-file path for SV-REG-03 dynamic registration |
| `SOA_RUNNER_AGENTS_MD_PATH` | §11.2.1 | AGENTS.md override path for deny-list fixture tests |
| `SOA_RUNNER_AUDIT_SINK_FAILURE_MODE` | §12.5.2 | Audit-sink state-machine driver for SV-PERM-19 |
| `RUNNER_CONSOLIDATION_TICK_MS` | §8.4.1 | Consolidation-scheduler tick override for SV-MEM-05 |
| `RUNNER_CONSOLIDATION_ELAPSED_MS` | §8.4.1 | Consolidation elapsed-threshold override |
| `RUNNER_SYNTHETIC_CACHE_HIT` | §13.3 / SV-BUD-04 | Per-decision cache-token increment |
| `RUNNER_RETENTION_SWEEP_TICK_MS` | §10.7.3 / SV-PRIV-04 | Retention-sweep tick-poll override |
| `RUNNER_RETENTION_SWEEP_INTERVAL_MS` | §10.7.3 / SV-PRIV-04 | Retention-sweep firing interval override |

These hooks are Experimental in the sense of §19.3 — they exist
solely for conformance testing and MAY change in any release
without a migration guide. Production deployments MUST NOT rely on
their behavior.

## Change protocol

Adding a field to this table requires a spec bump (Core §19 applies).
Demoting a Stable field to Provisional is a breaking change and MUST
wait for the next major version.

## Cross-references

- §19.3 Stability Tiers (definitions)
- §19.4 Versioning (SemVer + two-minor window)
- §19.5 Deprecation (≥ 2 minor releases lifetime)
- `docs/data-inventory.md` — field-level personal-data classification
- `migrations/1.x-to-1.y.md` — per-minor migration guides (future)
