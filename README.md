# soa-harness-impl

Reference implementation of **[SOA-Harness v1.0](https://github.com/wleeb1010/soa-harness-specification)** — the formal spec for Secure Operating Agents (SOA).

> **Status (2026-04-21):** M1 + M2 complete; M3 Week 2 shipped. Runner
> version `1.0`. 13 endpoints live on :7700; memory MCP mock shipped
> as a separate workspace package.

## Version

Current Runner version: **`1.0`**.

Per §19.4 version-policy errata: consuming v1.0 of this implementation
includes all §X.Y Observability additions pinned in the spec
`MANIFEST.supplementary_artifacts` at the time of the release. The spec
commit pinned in `soa-validate.lock` is authoritative for exactly which
schemas, fixtures, and normative sections ship with this binary.

### M3-era observability endpoints (v1.0)

- `GET /memory/state/:session_id` (§8.6)
- `GET /budget/projection?session_id=<sid>` (§13.5)
- `GET /tools/registered` (§11.4)
- `GET /events/recent?session_id=<sid>` (§14.5)

### M3-era test hooks (loopback only; production-guarded)

- `SOA_RUNNER_DYNAMIC_TOOL_REGISTRATION=<path>` (§11.3.1)
- `SOA_MEMORY_MCP_MOCK_TIMEOUT_AFTER_N_CALLS=<n>` (memory-mcp-mock)
- `SOA_MEMORY_MCP_MOCK_RETURN_ERROR=<tool_name>` (memory-mcp-mock)
- `SOA_MEMORY_MCP_MOCK_SEED=<path>` (memory-mcp-mock)
- `SOA_PRE_TOOL_USE_HOOK=<command>` (§15)
- `SOA_POST_TOOL_USE_HOOK=<command>` (§15)

Existing guards (M1 / M2): `RUNNER_TEST_CLOCK`,
`SOA_RUNNER_AUDIT_SINK_FAILURE_MODE`, `RUNNER_CRASH_TEST_MARKERS`.

See `docs/data-inventory.md` for the §10.7 data inventory.

## What's here

TypeScript monorepo (pnpm workspaces) with the following packages once M1 lands:

| Package | Purpose | Milestone |
|---|---|---|
| `@soa-harness/core` | Shared lib — JCS, SHA-256 digests, tasks fingerprint | M1 |
| `@soa-harness/schemas` | ajv-compiled validators bundled from spec schemas | M1 |
| `@soa-harness/runner` | Core-profile Runner | M1 (bootstrap/card/stream/permission/audit/hook/probes), M2 (session persistence), M3 (memory + budget) |
| `@soa-harness/gateway` | UI Gateway extending the spec's reference sketch | M3 |
| `@soa-harness/langgraph-adapter` | Thin wrapper that adds SOA-Harness compliance to existing LangGraph agents | M4 |
| `create-soa-agent` | `npx` scaffold that produces a runnable conformant agent in < 90 seconds | M1 |

## Not here yet

Everything. This repo is scaffold + planning-artifact references only until M1 begins.

## Sibling repos

- **[soa-harness-specification](https://github.com/wleeb1010/soa-harness-specification)** — the normative spec. This impl pins to a specific spec MANIFEST digest via `soa-validate.lock`.
- **[soa-validate](https://github.com/wleeb1010/soa-validate)** — the Go conformance harness. **Separate repo by design** so the implementation and validator are independently authored.

## Conformance positioning

When M1 ships, this repo will claim:
> SOA-Harness v1.0 Reference Implementation, pinned to spec commit `<sha>`, passing 8/213 tests as of M1.

Full conformance (passing all 213 tests) is an M5 deliverable, gated by an independent cryptographic review and a cross-implementation bake-off. Adopters should treat this repo as a **design contract + fork-able skeleton**, not a production-ready harness, until M5 lands.

## License

Apache 2.0. See `LICENSE`.

## Contributing

See `CONTRIBUTING.md`. Crypto-sensitive paths require two-reviewer approval — see `CODEOWNERS`.
