# Status — soa-harness-impl

## 2026-04-20 (Week 2 CLOSE)

### Week 2 closed — clock hook + boot wiring live, all four test IDs ready

**Signal for validator:** Week 2 impl live on :7700 with /health, /ready (gated by BootOrchestrator), Agent Card JSON + detached JWS, and the full verification-side libraries (`verifyAgentCardJws`, `verifyPda`, `resolvePermission`). Clock injection hook (L-01 §10.6.1) accepts `RUNNER_TEST_CLOCK` in non-prod; refuses when `NODE_ENV=production` or TLS binds non-loopback. Pinned to `fe74d39`. Validator cleared to run the full Week 2 live suite.

**Scoreboard:**
- `HR-01` — Trust bootstrap loader: green on `bootstrap.test.ts` (8) against the initial-trust fixture; loader is wired into `start-runner` bin and the `BootOrchestrator.boot()` path.
- `HR-02` — CRL cache three-state machine: green on `crl.test.ts` (8) + `clock.test.ts` (8) + `boot.test.ts` (7) with injected clocks driving every fresh / stale-but-valid / expired transition deterministically. Cache is warmed at boot and reassessed on every `/ready` call.
- `SV-BOOT-01` — Boot-time verification sequence: green on `boot.test.ts` including the 503 → 200 → 503 transition when wall-clock advances past the CRL 2h ceiling. Live on :7700 via `BootOrchestrator` wired into the plugin-scoped readiness probe.
- `SV-PERM-01` — Permission resolver (§10.3 + §10.4): green on `permission.test.ts` (19 tests including a 27-tuple sweep). `verifyPda` is the gatekeeper between the raw pda.jws and the resolver's `verifiedPda` input.

**Live smoke on 127.0.0.1:7700 (RUNNER_DEMO_MODE=1):**
- `/health` → 200 `{"status":"alive","soaHarnessVersion":"1.0"}`
- `/ready` → 200 `{"status":"ready"}` after boot; pre-boot and post-degradation → 503 with closed-enum reason
- `/.well-known/agent-card.json` + `/.well-known/agent-card.jws` → 200, protected header has `{alg, kid, typ=soa-agent-card+jws, x5c}`

**Clock hook (L-01):**
- `RUNNER_TEST_CLOCK=<ISO 8601>` adopted in non-prod; refuses when `NODE_ENV=production` OR TLS binds a non-loopback host. 0.0.0.0 + TLS fires the guard (loopback-indistinguishable).
- Consumed by `CrlCache`, `BootOrchestrator`, and `loadInitialTrust`. The PDA verifier already accepted a `now` parameter pre-L-01.
- 8 tests in `clock.test.ts` cover: wall-clock default, frozen-time adoption, prod-env guard, TLS-non-loopback guard, loopback TLS allowed, 0.0.0.0 guard fires, invalid ISO 8601 rejection.

**Pin:** `fe74d3931e50f52697d8fab0c07336a9f3bb099e`. MANIFEST regen (`00d6755df…`) re-hashed locally and matches the paste. `pin_history` records the adoption reason.

**Repo-wide:** 123 tests green (30 core + 4 schemas + 89 runner across 10 test files). `pnpm -r build / typecheck / lint / test` green. No cross-repo contracts left open.

## 2026-04-20 (end of day — big push)

### Week 2 — core verification pieces landed

- **Pin:** bumped `1f72bf6 → 9d25163` (lockstep with `soa-validate`; impl does not consume HR-01 / HR-02 vectors directly). `spec_manifest_sha256` updated — MANIFEST regen added 8 supplementary_artifacts for HR-01 / HR-02 (63 → 71). Re-hashed `MANIFEST.json` locally and matched the paste byte for byte.
- **Agent Card JWS verifier** (`packages/runner/src/card/verify.ts`) — detached-form parse, typ/alg/kid/x5c checks, `jose.importX509` + `jose.compactVerify` with reattached payload, x5c chain walk with SPKI match against trust anchors. 10-ish closed-enum `CardSignatureFailed` reasons. Full RFC 5280 path validation (SV-SIGN-04) intentionally deferred. 7 tests.
- **PDA verifier** (`packages/runner/src/attestation/verify-pda.ts`) — compact JWS, `typ=soa-pda+jws`, `canonical-decision.schema.json` validation, handler_kid equality check, 15-min window cap + 60s skew, injectable `HandlerKeyResolver` + optional `KidRevokedCheck`, final `jose.compactVerify`. 10 tests covering every failure path.
- **Permission resolver** (`packages/runner/src/permission/resolver.ts`) — Core §10.3 exactly: capability gate, tighten-only override throwing `ConfigPrecedenceViolation`, §10.4 Autonomous+Destructive guard, dispatch on AutoAllow / Prompt / Deny with PDA-satisfied / PDA-unsatisfied branches. 19 tests including a 27-tuple sweep of (capability × handler × control).

108 tests green (30 core + 4 schemas + 74 runner across 8 test files). Still pinned at spec `9d25163`.

- **Active:** Boot-time verification wiring (load trust → warm CRL → flip `/ready` 503→200) + live SV-PERM-01 smoke against the pda.jws fixture remain before Week 2 can be formally closed.
- **Blocked:** Nothing cross-repo. Validator session can begin SV-CARD-01 / SV-SIGN-01 / SV-PERM-01 runs against the existing endpoint; HR-01 / HR-02 validator-side assertions land when the boot sequence wires everything together.

## 2026-04-20 (end of day)

### Week 2 — /health + /ready probes wired and live

- **Done tonight:** `packages/runner/src/probes/` — Fastify plugin for `/health` and `/ready` per Core §5.4. `/health` returns 200 + `{"status":"alive","soaHarnessVersion":"1.0"}`; `/ready` returns 200 + `{"status":"ready"}` when the readiness probe passes, else 503 + `{"status":"not-ready","reason":"<enum>"}` with `reason` a closed enum of `bootstrap-pending | tool-pool-initializing | persistence-unwritable | audit-sink-unreachable | crl-stale` (no new reasons without a spec change). Default `ReadinessProbe` is `alwaysReady`; real per-component aggregators wire in when bootstrap, CRL, and audit sink land. 6 tests: health shape, health unauthenticated, ready default=200, ready with each of the 5 enum reasons, ready flips 503→200 dynamically.
- **Live smoke on 127.0.0.1:7700:** `/health` → 200 with the exact body the spec mandates; `/ready` → 200 {"status":"ready"}; card JSON + JWS still 200 — no route regressions.
- **Deferred:** Agent Card JWS verify + x5c chain walk, PDA verifier, Permission resolver, real readiness aggregation wiring these checks into `/ready`. Those remain on the Week 2 punch list.

72 tests green (30 core + 4 schemas + 38 runner).

## 2026-04-20 (later)

### Week 2 — day 1: CRL cache + Tool Registry landed

- **Done:**
  - CRL cache (`packages/runner/src/crl/`) implements UI §7.3.1 + Core §10.6 three-state freshness: `fresh` (age ≤ refresh interval, default 1h), `stale-but-valid` (> refresh interval, ≤ 2h ceiling, still within CRL `not_after`), `expired` (past `not_after` OR > 2h unreachable OR no cache entry). Only `expired` fails closed, with a specific `failureReason` of `crl-expired` / `crl-unreachable` / `crl-missing`. CRL bodies are schema-validated against the pinned `crl.schema.json`; invalid shapes throw on `refresh()`. 8 tests covering all state transitions, revoked-kid detection, schema rejection, and refresh semantics.
  - Tool Registry (`packages/runner/src/registry/`) loads a static `tools.json` and indexes by name. Each entry carries `name`, `risk_class` (closed enum: ReadOnly / Mutating / Egress / Destructive), `default_control` (closed enum: AutoAllow / Prompt / Deny). Constructor rejects duplicates and unknown enum values. 7 tests. Sample fixture with 4 demo tools (`fs__read_file`, `fs__write_file`, `fs__delete_file`, `net__http_get`).
- **Active:** Week 2 components 3-5 remain — Agent Card JWS verify + x5c chain walk, PDA verifier, Permission resolver, health/ready probes, boot-time verification wiring. These feed SV-BOOT-01 and SV-PERM-01.
- **Blocked:** Nothing on our side. Still pinned at spec `1f72bf6`.

66 tests green (30 core + 4 schemas + 32 runner). Runner test files: `bootstrap.test.ts` (8), `card.test.ts` (9), `crl.test.ts` (8), `registry.test.ts` (7).

---

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
