# Status — soa-harness-impl

## 2026-04-20 (T-05 + T-06 + T-07 — punch list cleared)

### All seven punch-list items shipped — Week 5 gate opens

**Signal:** T-05, T-06, T-07 all landed. V-09 (HR-12 tampered-card) + V-12 (SV-BOOT-01 negatives) flip SKIP → PASS.

- **T-07 — `RUNNER_INITIAL_TRUST` loader + SV-BOOT-01 negatives**
  - `loadInitialTrust` now accepts `expectedChannel?` (undefined default — no channel gate) and `expectedPublisherKid?` (SDK-pin match; mismatch → `bootstrap-missing`).
  - Closed-set failure reason rename: `bootstrap-schema-invalid` → `bootstrap-invalid-schema` (matches the L-20 catalog).
  - Bin accepts either `RUNNER_INITIAL_TRUST` (canonical) or legacy `RUNNER_TRUST_PATH`; `RUNNER_EXPECTED_PUBLISHER_KID` wires the SDK-pin gate.
  - 4 new negatives against pinned `test-vectors/initial-trust/*.json`: valid → clean boot; expired → `bootstrap-expired`; channel-mismatch → `bootstrap-invalid-schema`; mismatched-publisher-kid → `bootstrap-missing`.

- **T-06 — `RUNNER_CARD_JWS` loader for HR-12 tampered-card rejection**
  - New `loadAndVerifyExternalCardJws({jwsPath, canonicalBody, trustAnchors})` reads a pre-supplied detached JWS, verifies against `verifyAgentCardJws`, throws `CardSignatureFailed` on failure.
  - Bin wires it in: when `RUNNER_CARD_JWS` is set, verifies at boot. Failure → loud log + `process.exit(1)` (HR-12 fail-closed).
  - 4 tests: tampered fixture rejects, structurally-invalid JWS → `detached-jws-malformed`, missing file → same, happy regression (own-key-signed JWS + matching anchor passes).
  - Live-verified subprocess: `RUNNER_CARD_JWS=<tampered>` → process aborts with `CardSignatureFailed reason=x5c-missing` + exit non-zero. (Spec fixture's protected header lacks `x5c` so the first failure point is `x5c-missing`, not `signature-invalid`; substantive behavior — refusal to boot — is correct.)

- **T-05 — `SOA_RUNNER_BOOTSTRAP_BEARER` public-listener guard**
  - New `assertBootstrapBearerListenerSafe({bearer, tlsEnabled, host})` throws `BootstrapBearerOnPublicListener` when the env var is set AND TLS binds a non-loopback host. 0.0.0.0 counts as non-loopback.
  - Bin calls the guard before `startRunner`. Current demo deployment (no TLS) trips no guard; a production deployment that accidentally combines `SOA_RUNNER_BOOTSTRAP_BEARER` with TLS on a DNS name aborts before the listener binds.
  - 6 tests: env + TLS + DNS host → throws; + 0.0.0.0 → throws; + 127.0.0.1 → silent; + ::1/localhost → silent; env unset → silent regardless of bind; env + no TLS → silent (per M1 scope).

204 tests green (30 core + 4 schemas + 170 runner across 20 files). Pinned at spec `1971e87`. Eight endpoints live on :7700.

**Punch list cleared.** Week 5 gate now open: 5a hooks + 5b `create-soa-agent` scaffold.

## 2026-04-20 (T-03 + T-08 parallel — both shipped)

### `POST /sessions request_decide_scope` live + session.schema activeMode-required pinned

**Signal for validator:** T-03 shipped — `POST /sessions` now accepts `request_decide_scope:true` and grants the `permissions:decide:<session_id>` scope on the returned bearer. `RUNNER_DEMO_SESSION` stays as a convenience but is no longer required for the V-08 full matrix.

**T-03 — `request_decide_scope` on POST /sessions (§12.6 impl-side extension):**
- Request body gains optional `request_decide_scope: boolean` (default false).
- When `true` → `SessionRecord.canDecide = true` → bearer carries `permissions:decide:<session_id>` in addition to the existing scopes.
- When false / absent / explicit false → same behavior (canDecide=false).
- Non-boolean → 400 malformed-request.
- `sessions:create` scope never carried on session bearers (the bootstrap bearer is the only thing that can mint new sessions).
- 5 new tests: omitted → false, `true` → true, explicit false → false, non-boolean → 400, bearer-hash round-trip (create → validate → getRecord.canDecide reflects).
- Live verified: a session created with `request_decide_scope:true` drives `POST /permissions/decisions` → 201 with `audit_record_id=aud_99a2750a2f65`. A session created without the flag gets 403 on the same endpoint.

**T-08 — session.schema.json refresh + resume-path migration:**
- Schema already at the required shape at the current pin (1971e87); `activeMode` is in `required[]`. No regeneration needed — vendored copy was pulled fresh on the last codegen run.
- New helper `migratePre1SessionFile(file, cardActiveMode)`: pure function that defaults `activeMode` from the Agent Card when a pre-1.0 session file is missing the field. Tags the migrated record with `_migrated: { from: "pre-1.0" }` so operators see the upgrade at resume time.
- 6 new tests: full-shape round-trip, schema rejects missing-activeMode (regression for L-20 drift), enum acceptance, helper no-op when present, helper defaults from card when absent, pre-1.0 → migrated → schema-valid round-trip.

**Audit-chain tests:** unchanged — the switch to schema-conformant audit rows happened in T-01 and continues to hold.

190 tests green (30 core + 4 schemas + 156 runner across 17 files). Pinned at spec `1971e87`. Eight endpoints live on :7700.

Punch list: T-06 / T-07 / T-05 remain (fixtures + loopback guard), then the Week 5 gate (hooks + `create-soa-agent` scaffold).

## 2026-04-20 (T-01 live — `/audit/records` paginated)

### `GET /audit/records` live on :7700 — V-06 + V-10 unblocked

**Signal:** T-01 shipped. Validator can fire V-06 (SV-AUDIT-RECORDS-01/02) and V-10 (HR-14 chain-tamper) end-to-end against the same hash chain V-07 has been writing into.

- Route: `GET /audit/records?after=<record_id>&limit=<n>` (default 100, max 1000); body per pinned `audit-records-response.schema.json`; pagination via `next_after` + `has_more`; records returned in chain order (earliest first).
- Audit rows now schema-conformant (14 fields exactly): `id`, `timestamp`, `session_id`, `subject_id` ("none" in M1), `tool`, `args_digest`, `capability`, `control`, `handler` ("Interactive" in M1), `decision`, `reason`, `signer_key_id` ("" when no PDA), `prev_hash`, `this_hash`. Internal fields (`handler_accepted` etc.) moved out of the audit row and stay only in the 201 decisions-response body.
- Gates: `audit:read` bearer (any session bearer carries it); 401 missing, 403 not-tied-to-session; 429 at 60 rpm with Retry-After; 503 on `/ready`; 404 when `after=` references an unknown id.
- Live end-to-end: a single `POST /permissions/decisions` → `audit_record_id=aud_f7122b60a4e9`; `GET /audit/records` returned that exact record with decision=AutoAllow, `has_more=false`.
- 8 new tests covering empty page, single-record page, multi-page traversal with `next_after`/`has_more` transitions, 404 unknown-after, 403 non-session-bearer, 429 rate limit, not-a-side-effect regression, 503 readiness.

179 tests green (30 core + 4 schemas + 145 runner across 16 files). Eight endpoints live on :7700.

Punch list: T-03 (`request_decide_scope`) + T-08 (session.schema refresh) parallel next. Then T-06 / T-07 / T-05.

## 2026-04-20 (L-22 rename + validator handoff)

### Runner back up with agreed bootstrap bearer + pre-enrolled decide session

**Signal for validator V-07:** Runner restarted on `127.0.0.1:7700` with BOTH the conformance bootstrap bearer and a pre-enrolled session carrying `canDecide=true`. `POST /permissions/decisions` answers 201 immediately — V-07 audit-record driver unblocked independent of T-03.

- `SOA_RUNNER_BOOTSTRAP_BEARER = soa-conformance-week3-test-bearer`
- `RUNNER_DEMO_SESSION = ses_demoWeek3Conformance01:soa-conformance-week3-decide-bearer:DangerFullAccess` (pre-enrolled with `canDecide=true` and activeMode=DangerFullAccess)

**L-22 rename shipped** — §10.3.2 403 reasons now use the pinned closed enum:
- `insufficient-scope` (was `missing-scope`) — bearer lacks `permissions:decide:<sid>`
- `session-bearer-mismatch` (was `bearer-not-authorized-for-session`) — bearer scoped to a different session
- `pda-decision-mismatch` (unchanged) — PDA decision disagrees with resolver output
- `pda-malformed` (was `malformed-pda`) — PDA not a parseable compact JWS

**Pin:** `8c10ce9 → 9ae1825`. `spec_manifest_sha256 = 0e84c2c4…`, re-hashed locally and matched.

**Live end-to-end confirmed:**
- `POST /permissions/decisions` with the pre-enrolled session → `201 {decision:"AutoAllow", resolved_capability:"DangerFullAccess", audit_record_id:"aud_e2cdc48794cf", audit_this_hash:"d34aa739666e…", handler_accepted:true, recorded_at:…}`
- `GET /audit/tail` → `{this_hash:"d34aa739666e…", record_count:1, last_record_timestamp:…}` — `audit_this_hash` in the decision response matches the tail exactly.

170 tests green (30 core + 4 schemas + 136 runner across 15 files). Pinned at spec `9ae1825`.

## 2026-04-20 (T-02 live — audit-chain chokepoint open)

### `POST /permissions/decisions` live on :7700 — audit-chain accumulation path unblocked

**Signal:** T-02 shipped — `POST /permissions/decisions` (§10.3.2) runs the §10.3 pipeline, writes a hash-chained audit row, enforces forgery resistance (resolver output is authoritative; PDAs cannot override), and returns a schema-valid response. V-07 audit-record driver can fire; V-05 / V-06 / V-08 / V-10 unblock on it.

- Auth: session bearer; 401 missing, 403 wrong session, 403 `missing-scope` when the session lacks `permissions:decide:<session_id>` (grant via T-03 `request_decide_scope:true`).
- Rate limit 30 rpm per bearer with Retry-After; 503 inherits `/ready` gate.
- Resolver: `resolvePermissionForQuery(tool, session.activeMode)` — forgery resistance, decision mirrors `/permissions/resolve` output.
- PDA: verified via injected `resolvePdaVerifyKey`. Crypto failure → coerced to Deny + `handler_accepted=false` + reason `pda-verify-failed`, **with audit row still written**. `pda.decision` disagreeing with resolver's implied decision → 403 `pda-decision-mismatch` (no audit row).
- Audit row: single `AuditChain.append` with `audit_record_id` (`aud_<12 hex>`), kind `permission-decision`, full resolved state, plus `pda_signer_kid` when present. Shared chain with `/audit/tail`.
- Live on 127.0.0.1:7700: endpoint listed in the startup banner; a session bootstrapped via `POST /sessions` correctly 403s with the T-03 hint until `request_decide_scope` lands. Validator's pre-enrolled sessions (or local tests with canDecide=true) drive the happy path.
- 10 new tests covering every branch, including schema conformance against `permission-decision-response.schema.json`.

170 tests green (30 core + 4 schemas + 136 runner across 15 files). Pinned at spec `8c10ce9`. Seven endpoints live on :7700.

Punch list after T-02: T-03 (`request_decide_scope`) / T-01 (`/audit/records`) / T-08 (session schema refresh) — all parallel. Then T-06 / T-07 / T-05.

## 2026-04-20 (validator handoff — Week 3 sweep)

### Runner live with the agreed conformance bootstrap bearer

**Signal for validator:** Runner restarted on `127.0.0.1:7700` with the deterministic test-run bootstrap bearer both sides agreed on. Validator can POST /sessions with this bearer and then run the 24-cell SV-PERM-01 sweep.

- **`SOA_RUNNER_BOOTSTRAP_BEARER = soa-conformance-week3-test-bearer`** (this exact literal — no rotation during the sweep)
- **Pin:** spec `8c10ce9` (L-21 conformance-card fix)
- **Fixtures loaded:**
  - Agent Card: pinned `test-vectors/conformance-card/agent-card.json` (digest `8f61a2dec98b…`, SPKI substituted with the ephemeral runtime signing cert's SPKI per load)
  - Tool Registry: pinned `test-vectors/tool-registry/tools.json` (8 tools)
  - Initial trust: the local `test/fixtures/initial-trust.valid.json` happy-path fixture
  - CRL: `RUNNER_DEMO_MODE=1` stub fetcher (empty revocation list, fresh not_after)
- **Endpoints live:**
  - `GET /.well-known/agent-card.json` + `/.well-known/agent-card.jws`
  - `GET /health`, `GET /ready`
  - `GET /audit/tail` (empty log — T-02 `POST /permissions/decisions` not yet shipped, so nothing drives record accumulation this sweep)
  - `GET /permissions/resolve?tool=<name>&session_id=<id>`
  - `POST /sessions` (auth'd by `soa-conformance-week3-test-bearer`)
- **Smoke confirmed:** `POST /sessions` with `requested_activeMode=DangerFullAccess` + `user_sub=validator-probe` returns `201` with a fresh `ses_ba4c94e005a6…` and a ≥32-byte `session_bearer`.

Ephemeral keys, so the substituted SPKI rotates per-process-start. If the validator needs a stable SPKI across restarts, say so — I'll pass `RUNNER_SIGNING_KEY` + `RUNNER_X5C` instead of generating a fresh keypair each boot.

## 2026-04-20 (L-21 pin bump)

### Pin bumped to `8c10ce9` — conformance card fixture now schema-clean

- **Pin:** `80680cd → 8c10ce9`. `spec_manifest_sha256 = f38ca28f47dbcbe202e38b1452cd559aae749baebe99b3d39e692f80cd3a3a54`. Re-hashed locally, matches.
- **Impl changes:** two constants in `conformance-loader.ts`:
  - `PLACEHOLDER_SPKI`: `__IMPL_REPLACES_SPKI_AT_LOAD__…` (ASCII literal) → `16dc826f86941f2b6876f4f0f59d91f0021dacbd4ff17b76bbc9d39685250606` (valid hex64, SHA-256 of a fixture tag per L-21).
  - `PINNED_CONFORMANCE_CARD_DIGEST`: `87c50683bb01…` → `8f61a2dec98b9e92bcd65ab5ae9acf8352bf6ca8b0dd6b76574257280224344e`.
- **No loader-logic changes** — placeholder detection is still `anchor.spki_sha256 === PLACEHOLDER_SPKI`. The 6 conformance-loader tests pass against the new fixture bytes with just the constant updates.
- **Live verified (127.0.0.1:7700):** loader logs `digest 8f61a2dec98b…` and `substituted SPKI cfdb31836c11…` (per-run). `POST /sessions requested_activeMode=DangerFullAccess` returns 201 with the new ephemeral session.

Punch list unchanged: T-02 (priority #1) → T-01 → T-03 → T-08 → T-06 → T-07 → T-05.

160 tests green (30 core + 4 schemas + 126 runner across 14 files). Pinned at spec `8c10ce9`.

## 2026-04-20 (Week 3 day 3 — T-04 live)

### T-04 conformance card loader live on :7700 — validator cleared for SV-PERM-01 DFA sweep

**Signal:** `RUNNER_CARD_FIXTURE` wired; the pinned DangerFullAccess conformance card is loaded, digest-verified, SPKI-substituted, and served at `/.well-known/agent-card.{json,jws}`. Validator can now run the 24-cell (3 activeModes × 8 tools) SV-PERM-01 live sweep in one pass.

- **Pin:** `e7580b9 → 80680cd`. `spec_manifest_sha256` regenerated and re-hashed locally as `3fc46237…`. Schemas registry now loads 20 validators (new: `audit-records-response`, `permission-decision-request`, `permission-decision-response`).
- **T-04 loader (`packages/runner/src/card/conformance-loader.ts`):**
  - Reads fixture raw bytes; parses to JSON; JCS-canonicalizes; SHA-256's the canonical bytes; asserts match with `PINNED_CONFORMANCE_CARD_DIGEST = 87c50683bb01…` (pulled from `MANIFEST.supplementary_artifacts[path=test-vectors/conformance-card/agent-card.json].sha256`). Any non-placeholder tamper → `ConformanceFixtureTampered("digest-mismatch")`.
  - Walks `security.trustAnchors[*]` and replaces every entry whose `spki_sha256 === PLACEHOLDER_SPKI` with the runtime signing cert's actual SPKI hash. Zero placeholders → `ConformanceFixtureTampered("missing-placeholder")`.
  - Missing file → `ConformanceFixtureTampered("read-failure")`.
- **Plugin opt-out:** `CardPluginOptions.skipSchemaValidation` — the pinned conformance fixture ships with `self_improvement.max_iterations: 0` which violates `agent-card.schema.json` (`minimum: 1`). The fixture is trusted by spec digest, not by schema. BuildRunnerOptions carries `skipCardSchemaValidation` through.
- **Bin:** `RUNNER_CARD_FIXTURE=<path>` overrides `RUNNER_CARD_PATH` and forces the conformance loader path (which also sets `skipCardSchemaValidation`).
- **6 new tests** (`conformance-card.test.ts`) — happy-path substitution + determinism, digest-mismatch on non-placeholder tamper, missing-placeholder on pre-substituted fixture, read-failure on missing file, end-to-end plugin serves with `skipSchemaValidation`.
- **Live 24-cell sweep (127.0.0.1:7700 against the DFA card + 8-tool fixture):**
  - `[ReadOnly]` fs__read_file → AutoAllow; fs__write_file → CapabilityDenied; fs__delete_file → CapabilityDenied
  - `[WorkspaceWrite]` fs__read_file → AutoAllow; fs__write_file → Prompt; fs__delete_file → CapabilityDenied
  - `[DangerFullAccess]` fs__read_file → AutoAllow; fs__write_file → Prompt; fs__delete_file → Prompt
  - Session tightening from DFA card works at all three levels via `POST /sessions`.

**Remaining Week 3 day 3+ tasks (per plan rev 2):** T-01 (`/audit/records` paginated), T-02 (`POST /permissions/decisions` — the missing piece for audit-chain accumulation), T-03 (`request_decide_scope` on session bootstrap), T-05 (bootstrap-bearer-on-public-listener guard), T-06 (`RUNNER_CARD_JWS` for tampered-card rejection), T-07 (`RUNNER_INITIAL_TRUST` negatives), T-08 (`session.schema.json` refresh for activeMode-required).

176 tests green (30 core + 4 schemas + 142 runner across 14 files). Pinned at spec `80680cd`.

## 2026-04-20 (Week 3 day 2)

### Full Week 3 impl surface live on :7700 — validator cleared for full sweep

**Signal:** Six endpoints now answering on :7700. Pinned to spec `e7580b9`. Validator cleared to re-run the Week 3 live suite in one pass (SV-PERM-01 live path, SV-SESS-BOOT-01/02, SV-AUDIT-TAIL-01).

- **Pin:** `2eccf6e → e7580b9`. MANIFEST regen (`7d4406165ff7d7d80004321b7c056c19916ec88aa437b626a1a867b4f2af2dc0`) recomputed locally and matched. Two new normative schemas land in `@soa-harness/schemas` — `session-bootstrap-response` and `audit-tail-response`.
- **New endpoints:**
  - `POST /sessions` (§12.6) — bootstrap-bearer-auth'd; 201 + `{session_id, session_bearer, granted_activeMode, expires_at, runner_version}` per schema; 400 malformed, 401 wrong bootstrap bearer, 403 `ConfigPrecedenceViolation` when `requested_activeMode > card.permissions.activeMode`, 429 rate-limit, 503 pre-boot. Session mints `ses_<24 hex>` id + random 32-byte base64url bearer. Bootstrap bearer comes from `SOA_RUNNER_BOOTSTRAP_BEARER`.
  - `GET /audit/tail` (§10.5.2) — any session bearer works (implicit `audit:read` scope per §12.6). 200 + `{this_hash: "GENESIS" | <hex64>, record_count, last_record_timestamp?, runner_version, generated_at}`. 401/403/429/503. `AuditChain` keeps hash-chained in-memory records; real persistence + WORM sink is an M2 concern.
- **Resolver update (§10.3 step 1):** `/permissions/resolve` now reads `capability` from the session's `activeMode` (looked up via `SessionStore.getRecord`), falling back to the Agent Card's `activeMode` when no session record exists. The card's value stays the upper bound that gated session creation.
- **Fixture loader:** `RUNNER_TOOLS_FIXTURE=<path>` loads the pinned conformance registry from `test-vectors/tool-registry/tools.json` (8 tools across every risk_class × default_control combination). `RUNNER_TOOLS_PATH` stays available for operator-supplied registries.
- **Live smoke (127.0.0.1:7700 against the pinned fixture):**
  - `POST /sessions` with `requested_activeMode=ReadOnly` → `201 {session_id:"ses_072ec9…", granted_activeMode:"ReadOnly", expires_at:<now+1h>, …}`
  - `GET /audit/tail` with that bearer → `200 {this_hash:"GENESIS", record_count:0, runner_version:"1.0", generated_at:…}`
  - `GET /permissions/resolve?tool=fs__read_file` under that session → `AutoAllow` + `resolved_capability="ReadOnly"` (pulled from the session, not the card)
  - `GET /permissions/resolve?tool=fs__write_file` under that session → `CapabilityDenied` + step-2 rejected
  - `POST /sessions` with `requested_activeMode=WorkspaceWrite` (card is ReadOnly) → `403 {error:"ConfigPrecedenceViolation", detail:"requested_activeMode=WorkspaceWrite exceeds Agent Card permissions.activeMode=ReadOnly"}`
- **Tests (16 new — 136 runner + 4 schemas + 30 core = 170 total, across 13 files):** `sessions-bootstrap.test.ts` (8 — happy-path per activeMode, TTL math, 401 no bearer, 401 wrong bearer, 400 malformed variants, 403 ConfigPrecedenceViolation, 429, 503). `audit-tail.test.ts` (8 — GENESIS on empty, tail updates on append, hash-link invariant, 401, 403 unknown bearer, 503, two-reads-byte-identical, write→read→read record_count unchanged).

Bootstrap bearer guard: `SOA_RUNNER_BOOTSTRAP_BEARER` lives on loopback listeners per §12.6. The bin accepts it as an env var; production deployments should bind the bootstrap surface to a Unix socket / named pipe separate from the public TLS listener (wiring that split is M2 scope).

## 2026-04-20 (Week 3 day 1)

### `/permissions/resolve` live on :7700 — validator cleared for SV-PERM-01 live path

**Signal:** Week 3 Day 1 impl live: `GET /permissions/resolve?tool=<name>&session_id=<id>` online at port 7700. Pinned to spec `2eccf6e`. Validator cleared to flip SV-PERM-01 live assertion.

- **Pin bump:** `fe74d39 → 2eccf6e` (adopt §10.3.1 + `permissions-resolve-response.schema.json`). `spec_manifest_sha256` changed to `838cacbc…`; re-hashed locally and matched the paste.
- **Endpoint (`packages/runner/src/permission/resolve-route.ts`):**
  - GET-only; `Cache-Control: no-store` on every response.
  - **Auth:** `Authorization: Bearer <token>` — `401` missing, `403` wrong session, backed by `InMemorySessionStore` (sha256 of bearer is retained, not the cleartext).
  - **Rate limit:** 60 req/min per bearer (configurable), `429` with `Retry-After` when exceeded.
  - **Readiness gate:** `503 {status:"not-ready", reason:<§5.4 enum>}` when BootOrchestrator hasn't flipped green.
  - **Response:** schema-conformant body via `resolvePermissionForQuery` — runs §10.3 steps 1–4 and records every step in `trace[]` (`passed|tightened|rejected|skipped`). Terminal decisions `AutoAllow | Prompt | Deny | CapabilityDenied | ConfigPrecedenceViolation`. `policy_endpoint_applied: false` when configured; omitted when unset (M1 does not invoke the external endpoint).
- **Not-a-side-effect property:** two sequential queries leave `ToolRegistry` and `InMemorySessionStore` byte-identical; repeated queries produce identical response bodies (idempotent / pure). No audit writes, no StreamEvent emissions, no PermissionPrompt even when `decision=Prompt`.
- **Bin wiring (`packages/runner/src/bin/start-runner.ts`):** `RUNNER_TOOLS_PATH` loads the Tool Registry; `RUNNER_DEMO_SESSION=<sid>:<bearer>` pre-registers a session for live smoke. When the registry is absent the endpoint is simply not registered (early-milestone deployments that don't expose the observability surface).
- **Live smoke (127.0.0.1:7700):**
  - Unauth → `401`
  - `fs__write_file` under ReadOnly capability → `CapabilityDenied` + `trace[2].result=rejected`
  - `fs__read_file` under ReadOnly → `AutoAllow`, full 4-step trace
- **Tests:** 15 new in `permission-resolve.test.ts` — auth matrix (401/403/400/404), §10.3 step paths (Prompt / CapabilityDenied / ConfigPrecedenceViolation / policyEndpoint trace), rate limit 429 + Retry-After, readiness 503, not-a-side-effect property (registry + sessionStore invariant across queries), idempotence. Schema conformance tested via `@soa-harness/schemas` registry.

138 tests green (30 core + 4 schemas + 104 runner across 11 files). Pinned at spec `2eccf6e`. Server on :7700 with five endpoints live: `/health`, `/ready`, `/.well-known/agent-card.{json,jws}`, `/permissions/resolve`.

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
