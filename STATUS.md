# Status — soa-harness-impl

## 2026-04-20

### Week 1 CLOSED — standing by for Week 2

- **SV-CARD-01:** green on vector AND live. Vector-based unit assertion (protected-header structure, `typ=soa-agent-card+jws`, ETag shape, Cache-Control) + live run against `127.0.0.1:7700/.well-known/agent-card.json`.
- **SV-SIGN-01:** green on vector AND live. Detached JWS round-trips through `jose.flattenedVerify` (reattached payload) AND through `jose.compactVerify` (reassembled form); protected header decodes to `{alg:"EdDSA", kid:"soa-release-v1.0", typ:"soa-agent-card+jws", x5c:["MIIBHDC…"]}`.
- **Three conformance fixes landed** (spec commit `1f72bf6`): URL path `.json.jws → .jws`, `typ` `soa-card+jws → soa-agent-card+jws`, `x5c` required in protected header (leaf-first RFC 7515 §4.1.6 base64 DER array).
- **Pinned to `1f72bf6`.** `soa-validate.lock` bumped `6c1bc99 → 1f72bf6` (readability fix; no normative change, no MANIFEST regen). `pin_history` carries the rationale.
- **Week 1 complete.** Standing by for Week 2 kickoff (StreamEvent SSE emitter — §14.1 closed enum, `/stream/v1/:session_id`, integration against the spec's `stream-event-payloads.schema.json`).

51 tests green (30 core + 4 schemas + 17 runner). No cross-repo contracts left open. Sibling spec and `soa-validate` both pinned at `1f72bf6`.

### Week 1 conformance fix — URL + typ + x5c corrected

**Impl Week 1 conformance fix landed, URL+typ+x5c corrected, pinned to `1f72bf6`, validate session cleared to re-run live.**

- URL path `/.well-known/agent-card.json.jws` → `/.well-known/agent-card.jws` (matches §6.1 line 221 and the §5.1 shorthand clarified in spec commit `1f72bf6`).
- JWS `typ` `soa-card+jws` → `soa-agent-card+jws` per §6.1.1 row 1.
- Protected header now carries the full `{alg, kid, typ, x5c}` set §6.1.1 mandates. `x5c` is a required `CardSignOptions` field — a non-empty RFC 7515 §4.1.6 leaf-first base64-DER cert array. The signer rejects an empty `x5c` rather than emitting a non-conformant header.
- Demo bin: when no operator cert chain is supplied (`RUNNER_SIGNING_KEY` + `RUNNER_X5C` missing), generates an ephemeral Ed25519 keypair AND a self-signed X.509 cert over it via `@peculiar/x509`, then feeds the DER into `x5c[0]`. Loud warning notes a self-signed leaf does not chain to any real trust anchor — production supplies a chain anchored in `security.trustAnchors`.
- Pin bumped `6c1bc99 → 1f72bf6`; `spec_manifest_sha256` unchanged (no MANIFEST regen). `pin_history` entry records the readability-fix rationale.
- Live smoke on 127.0.0.1: `GET /.well-known/agent-card.jws` → 200 + `application/jose` + detached `h..s`; decoded protected header is `{"alg":"EdDSA","kid":"soa-release-v1.0","typ":"soa-agent-card+jws","x5c":["MIIBHDC…"]}`. Old URL returns 404, confirming no residual route.
- 51 tests green: 30 core + 4 schemas + 17 runner (8 bootstrap + 9 card, the new card test is the `x5c`-header structural assertion).

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
