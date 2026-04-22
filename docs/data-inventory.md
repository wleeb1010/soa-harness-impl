# Data Inventory — SOA-Harness Reference Implementation

Required by Core §10.7 point 1: "Every deployment MUST publish a
data-inventory document at `docs/data-inventory.md` enumerating, per
primitive, which fields MAY contain personal data, the field's
retention category (see §10.7.3), and the legal basis asserted for
collection. Absence of the file fails conformance (`SV-PRIV-01`)."

**Scope.** This file describes personal-data surfaces of the
reference-implementation Runner. Full operator deployments extend this
document with deployment-specific personal-data inventories (CRM
fields, user profile store, tool-side data stores, etc.).

**Status.** M3-T11b scaffold. Field tagging + enforcement wiring lands
with M3-T12 in Week 4.

---

## Primitives and personal-data surfaces

### §5 Agent Card

| Field | Personal data | Retention category | Legal basis |
|---|---|---|---|
| `publisher_kid` | No (public identifier) | n/a | n/a |
| `security.trustAnchors[*]` | No | n/a | n/a |
| `permissions.*` | No | n/a | n/a |
| `memory.mcp_endpoint` | No (URL) | n/a | n/a |

### §6 Agent Card JWS

No personal data — all fields derive from the signed Agent Card body.

### §8 Memory

| Field | Personal data | Retention category | Legal basis |
|---|---|---|---|
| `notes[*].summary` | MAY (free text) | `memory-personal` (§10.7.3) when `data_class ∈ {personal, sensitive-personal}` | Operator-declared per deployment |
| `notes[*].data_class` | No (enum tag) | n/a | n/a |
| `notes[*].composite_score` | No | n/a | n/a |
| `user_sub` | Yes (stable subject identifier) | `operational-personal` (60 days default) | Operator-declared |

### §10.3.2 Permission Decisions

| Field | Personal data | Retention category | Legal basis |
|---|---|---|---|
| `audit.subject_id` | Yes (subject binding per §10.7 mapping rule) | `audit-personal` (≤ 400 days) | Legal obligation (audit) |
| `audit.reason` | MAY (free text — operators SHOULD redact) | `audit-personal` | Legal obligation |
| `audit.signer_key_id` | No (key identifier) | n/a | n/a |

### §12 Session Persistence

| Field | Personal data | Retention category | Legal basis |
|---|---|---|---|
| `session.messages[*]` | MAY (free text) | `operational-personal` | Operator-declared |
| `workflow.side_effects[*].args_digest` | No (SHA-256 hash) | n/a | n/a |
| `user_sub` | Yes | `operational-personal` | Operator-declared |

### §14 StreamEvent

Per §14.1 payload schemas — most event types carry no personal data.
`MessageStart` / `ContentBlockDelta` / `ToolInputDelta` MAY carry free
text; operators SHOULD redact at the Gateway per UI §15.6 rules.

### §10.5 Audit Log

Records carry `subject_id` — the authoritative personal-data linkage
per §10.7.1. See Permission Decisions row above.

---

## Retention categories (§10.7.3)

| Category | TTL |
|---|---|
| `operational-personal` | 60 days (default; operator may shorten) |
| `audit-personal` | ≤ 400 days, capped by legal maximum + operator policy |
| `memory-personal` | Consolidation horizon per §8.2, cap 400 days |

## Subject-access operations (§10.7.1)

The reference Runner exposes `privacy.delete_subject` +
`privacy.export_subject` as MCP tools. In M3-T11b scope these are
scaffold placeholders — full behavior (memory redaction, audit
`SubjectSuppression` stubs, session purge) lands with M3-T12 Week 4.

Deployments register these tools via:
- Static-fixture registration: include them in the pinned Tool
  Registry fixture at boot (§11.1).
- Dynamic registration: write their entries to
  `SOA_RUNNER_DYNAMIC_TOOL_REGISTRATION` trigger file (§11.3.1, L-34).

Either path surfaces them on `GET /tools/registered` with the
correct `registration_source` metadata.

## Legal-basis catalog (operator responsibility)

The reference implementation does NOT assert a legal basis; production
deployments MUST declare one per personal-data field above. Common
values:
- `legitimate-interest`
- `contract-performance`
- `legal-obligation`
- `user-consent`

## Cross-references

- §8.6 — Memory state observability
- §10.5 — Audit log schema
- §10.7 — Privacy and data-governance controls
- §10.7.1 — Deletion + subject-access semantics
- §10.7.2 — Cross-border residency
- §10.7.3 — Retention
- §12.1 — Session file schema
- §14.1 — StreamEvent closed enum
