# soa-harness-impl

Reference implementation of **[SOA-Harness v1.0](https://github.com/wleeb1010/soa-harness-specification)** — the formal spec for **Secure Operating Agents**.

SOA-Harness defines a production-standard harness for agentic AI runtimes: cryptographically-signed agent identity, permission gating, hash-chained audit, structured streaming, token budgets, crash-safe session persistence, and a conformance test suite (`soa-validate`). This repo is the TypeScript reference implementation of that spec.

---

## Quick start (~15 min, fresh laptop)

**Prerequisites:** Node.js 20+ (22 recommended), npm 10+.

Scaffold a new agent project, install deps, launch the Runner:

```bash
npx create-soa-agent@next my-agent
cd my-agent
npm install
node ./start.mjs
```

Expected output:
```
[create-soa-agent] WARNING: generated a synthetic Ed25519 keypair ...
[create-soa-agent] scaffolded 3 files into /.../my-agent
[demo] first audit row produced: aud_<hex> (AutoAllow); session=ses_<hex>
[demo] Runner live at http://127.0.0.1:7700 — Ctrl-C to stop
```

In a second terminal, verify the HTTP surface:

```bash
curl -s http://127.0.0.1:7700/health
# {"status":"alive","soaHarnessVersion":"1.0"}

curl -s http://127.0.0.1:7700/.well-known/agent-card.json | jq .name
# "demo-agent"

curl -s -I http://127.0.0.1:7700/.well-known/agent-card.jws | head -1
# HTTP/1.1 200 OK
```

**Wall-clock benchmarks** (captured in `docs/m4/dry-run-telemetry.md`):
- Windows 11 (PowerShell): 7.5s end-to-end
- WSL2 Ubuntu 24.04: 11.8s end-to-end

---

## Which path? Decision tree

Two consumption modes, mutually exclusive:

### (a) Scaffold a new agent — `create-soa-agent`

Use when: starting from scratch, want a working SOA-conformant Runner as your base.

```bash
npx create-soa-agent@next my-agent
```

Ships a minimal ReadOnly agent with a self-signed demo keypair. Replace the Agent Card + keys + tools with your own before deploying anywhere non-local.

### (b) Wrap an existing LangGraph agent — `@soa-harness/langgraph-adapter`

Use when: you already have a LangGraph `StateGraph` and want to make it SOA-conformant (signed Agent Card, permission interception, audit chain, StreamEvent emission).

```bash
npm install @soa-harness/langgraph-adapter@next
```

See [`packages/langgraph-adapter/README.md`](packages/langgraph-adapter/README.md) for the wrapping recipe. Conformance to SOA-Harness §18.5 Adapter Conformance requires pre-dispatch permission interception per §18.5.2 — the adapter handles this automatically.

**Do not combine both paths in the same project** — pick one.

---

## What you get

A running Runner exposes the following HTTP surface (per [SOA-Harness spec §5–§15](https://github.com/wleeb1010/soa-harness-specification)):

| Endpoint | Purpose | Spec |
|---|---|---|
| `GET /.well-known/agent-card.json` | Unsigned Agent Card | §6 |
| `GET /.well-known/agent-card.jws` | Signed Agent Card (Ed25519) | §6.1.1 |
| `GET /health`, `GET /ready` | Operational probes | §5.4 |
| `POST /sessions` | Session bootstrap + bearer mint | §12.6 |
| `GET /stream/v1/:sessionID` | StreamEvent SSE channel | §14.3 |
| `POST /permissions/decisions` | Record a signed PDA | §10.3.2 |
| `GET /audit/tail`, `GET /audit/records` | Audit-chain observability | §10.5 |
| `GET /memory/state/:session_id` | Memory layer observability | §8.6 |
| `GET /budget/projection` | Token-budget observability | §13.5 |
| `GET /tools/registered` | Tool Registry observability | §11.4 |
| `GET /events/recent` | StreamEvent polling (§14.5) + admin post-crash (§14.5.5) | §14.5 |
| `GET /logs/system/recent` | System event log | §14.5.4 |
| `GET /observability/backpressure` | OTel span-emission backpressure | §14.5.3 |

Plus wiring for PreToolUse / PostToolUse hooks (§15), CRL cache (§7.3.1), handler key rotation (§10.6), and dynamic MCP tool registration (§11.3.1).

---

## Packages

Published under the [`@soa-harness` npm organization](https://www.npmjs.com/org/soa-harness) and [`create-soa-agent`](https://www.npmjs.com/package/create-soa-agent) (unscoped).

| Package | Version | Purpose |
|---|---|---|
| `@soa-harness/core` | `1.0.0-rc.0` | JCS canonicalization, SHA-256 digests, tasks fingerprint |
| `@soa-harness/schemas` | `1.0.0-rc.0` | ajv-compiled validators (vendored from spec-pinned schemas) |
| `@soa-harness/runner` | `1.0.0-rc.1` | Runner HTTP surface, trust bootstrap, Agent Card, permission, audit, hooks, probes |
| `create-soa-agent` | `1.0.0-rc.2` | `npx` scaffold producing a working SOA agent in seconds |
| `@soa-harness/langgraph-adapter` | (in-progress) | Adapter for wrapping LangGraph `StateGraph` agents |

All current releases are under the `next` dist-tag (release-candidate). `1.0.0` final ships after conformance audit (see below).

---

## Conformance status

| Metric | Current |
|---|---|
| `soa-validate` tests passing | 156/162 expected (152 core + 4 SV-ADAPTER) |
| Deferred (documented) | 6 |
| Failing | 0 |

Conformance is validated by **[soa-validate](https://github.com/wleeb1010/soa-validate)**, a separate Go conformance harness. The three-repo split — spec / impl / validate — prevents self-proving conformance.

Final `v1.0.0` tag ships after:
- All three memory-backend reference impls pass (`memory-mcp-sqlite`, `memory-mcp-mem0`, `memory-mcp-zep`)
- Independent cryptographic review of `packages/core` + `packages/runner/src/audit` + `packages/runner/src/session`
- External-reviewer onboarding gate (three fresh-laptop reviewers reach `soa-validate` green within platform budget)

---

## Configuration surface

Environment variables the Runner reads (non-exhaustive; see `packages/runner/src/config.ts` for the full list):

| Var | Purpose | Scope |
|---|---|---|
| `PORT` | Runner listen port (default `7700`) | All |
| `SOA_RUNNER_BOOTSTRAP_BEARER` | Initial admin bearer (demo only — rotate in prod) | All |
| `RUNNER_SIGNING_KEY` | Agent Card signing key (PKCS#8 PEM, Ed25519) | Production |
| `RUNNER_X5C` | Agent Card cert chain (PEM) | Production |
| `SOA_RUNNER_DYNAMIC_TOOL_REGISTRATION` | Path to MCP tool manifest | §11.3.1 |
| `SOA_MEMORY_MCP_ENDPOINT` | Memory MCP server URL | §8 |
| `SOA_PRE_TOOL_USE_HOOK`, `SOA_POST_TOOL_USE_HOOK` | §15 hook commands | §15 |

Loopback-only test hooks are prefixed `SOA_*_TEST_*` / `RUNNER_TEST_*` and refuse to bind on non-loopback interfaces.

---

## Sibling repos

- **[soa-harness-specification](https://github.com/wleeb1010/soa-harness-specification)** — normative spec (Markdown + JSON Schemas + test vectors). This impl pins to a specific spec MANIFEST digest via `soa-validate.lock`.
- **[soa-validate](https://github.com/wleeb1010/soa-validate)** — Go conformance harness. Separate repo by design so the implementation and validator are independently authored.

## Development

```bash
git clone https://github.com/wleeb1010/soa-harness-impl
cd soa-harness-impl
pnpm install
pnpm -r build
pnpm -r test   # ~785 tests across 5 packages
```

For in-monorepo scaffold iteration (file-linked runner instead of registry):

```bash
npx create-soa-agent --link my-agent
```

## Publish process

See [`docs/m4/publish-runbook.md`](docs/m4/publish-runbook.md) for the full recipe — pre-publish checklist, dist-tag discipline, post-publish verification, rollback.

## License

Apache 2.0. See [`LICENSE`](LICENSE).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Crypto-sensitive paths (`packages/core`, `packages/runner/src/audit`, `packages/runner/src/session`) require two-reviewer approval — see [`CODEOWNERS`](CODEOWNERS).
