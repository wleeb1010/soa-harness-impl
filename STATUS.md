# Status — soa-harness-impl

## 2026-04-20

### Week 1 — Agent Card endpoint LIVE

**Agent Card endpoint live at :7700 — validator can run SV-CARD-01 and SV-SIGN-01.**

- **Done:**
  - Trust bootstrap (`packages/runner/src/bootstrap/`): `loadInitialTrust` reads + schema-validates `initial-trust.json` against `@soa-harness/schemas`, rejects UTF-8 BOM, enforces `not_after`, enforces SDK-pinned channel for M1, throws typed `HostHardeningInsufficient` with the spec's `§5.3` closed-set reason codes.
  - Agent Card server (`packages/runner/src/card/`): Fastify plugin serves `GET /.well-known/agent-card.json` (JCS-canonical bytes) and `GET /.well-known/agent-card.json.jws` (detached EdDSA JWS, `typ=soa-card+jws`). Shared ETag from `sha256(canonical body)`, `Cache-Control: max-age=300`, `If-None-Match → 304` honored. Card is schema-validated at startup — invalid cards fail the plugin init rather than serve.
  - Server entrypoint (`packages/runner/src/server.ts` + `src/bin/start-runner.ts`): `buildRunnerApp` is injectable for tests; `startRunner` binds the port with optional TLS (`minVersion: "TLSv1.3"` when certs provided). Bin invokes via `node dist/bin/start-runner.js` or `pnpm --filter @soa-harness/runner start`.
  - Schemas codegen swapped from Ajv standalone (broken under ESM — emitted `require(...)`) to runtime compile at module load. 14 validators load in < 5ms on cold start, well within the demo budget.
  - 15 new tests: 8 bootstrap (valid, missing, malformed, BOM, schema-invalid, expired, channel-mismatch, default channel) + 7 card (200 JSON, 200 JWS, shared ETag, 304, detached-reattach verifies, compact-reassemble verifies, ETag changes on content change).
- **Live smoke (Windows host):** `127.0.0.1:7700/.well-known/agent-card.json` → 200 + JCS-canonical body + `ETag: "0d86a163…"` + `Cache-Control: max-age=300`. `.jws` → `eyJhbGciOiJFZERTQSIsImtpZCI6InNvYS1yZWxlYXNlLXYxLjAi…..0qO1w…` (detached `h..s`, EdDSA, kid `soa-release-v1.0`).
- **Active:** Week 2 — StreamEvent SSE emitter (§14.1 closed enum) is next once the validator session confirms SV-CARD-01 / SV-SIGN-01 pass against this endpoint.
- **Blocked:** Nothing on our side.

Local verification: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` all green. 49 tests passing (30 core + 4 schemas + 15 runner).

Sibling spec pinned at `6c1bc99` (lockstep with `soa-validate`).

---

## 2026-04-20 (earlier)

### Week 0 sign-off (post-parity)

Parity test reconfirmed green (13/13) after pulling. Pin is already
at `6c1bc9916472f23dcf237f5634f3ff33baff45e9` — the sibling `soa-validate`
repo pins the same commit, so impl and validator are in lockstep on
the same spec. No further bump required to close Week 0; next commit
begins Week 1 (trust bootstrap + Agent Card).

### Week 0 closed

- Day 1 repo wiring: pnpm workspace, strict TS, 4 package skeletons, Node 20 CI on Ubuntu/macOS/Windows.
- Day 4 schemas package: 14 Ajv 2020-12 validators registry'd from the pinned spec, 4 smoke tests.
- Day 5 `@soa-harness/core` helpers: `jcs`, `digest`, `tasks-fingerprint`. 17 unit tests.
- Day 2-3 JCS cross-language parity test: 13 tests against 47-case generated vectors, all green.
- Pin bumped `208e5dd → 6c1bc99` in lockstep with `soa-validate`.
