# soa-harness-impl

Reference implementation of **[SOA-Harness v1.0](https://github.com/wleeb1010/soa-harness-specification)** — the formal spec for secure autonomous agents.

> **Status (2026-04-20): pre-M1 scaffold.** No functional code yet. See `~/.claude/plans/put-a-plan-together-glittery-hartmanis.md` for milestone schedule. First working Runner ships with M1 (target: 6 weeks from kickoff).

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
