# Status — soa-harness-impl

## 2026-04-20

### Week 0 closed

- **Done:**
  - Day 1 repo wiring: pnpm workspace, strict TS, 4 package skeletons, Node 20 CI on Ubuntu/macOS/Windows.
  - Day 4 schemas package: 14 standalone Ajv 2020-12 validators codegen'd from the pinned spec, typed registry, 4 smoke tests.
  - Day 5 `@soa-harness/core` helpers: `jcs` (wrapper over Erdtman's `canonicalize`), `digest` (sha256Hex/digestJson/digestRawUtf8), `tasks-fingerprint` (port of spec's `compute.mjs`). 17 unit tests, including a parity test against the spec's tasks-fingerprint fixture.
  - Day 2-3 JCS cross-language parity test: consumes the pinned spec's `test-vectors/jcs-parity/generated/*.json` (4 files, 47 libraries-agree cases), asserts our `canonicalize()` output matches `expected_canonical` byte for byte. Fails loudly on any `libraries_agree: false` entry — no paper-over path.
  - Pin bump: `208e5dd` → `6c1bc99` (adopts the generated parity vectors). Retroactive `9f79302 → 208e5dd` entry added to `pin_history` so the trail is continuous.
- **Active:** Week 1 — Trust bootstrap (`packages/runner/src/bootstrap/`) + Agent Card server (`packages/runner/src/card/`), gated by test IDs SV-CARD-01 and SV-SIGN-01.
- **Blocked:** Nothing on our side. No cross-repo contracts crossed; validator session can continue independently.

Local verification: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` all green on Windows. 34 tests passing (21 core + 13 schemas across 5 test files).

Sibling spec pinned at `6c1bc99`; sibling validate session has parity vectors published.

### Week 0 sign-off (post-parity)

Parity test reconfirmed green (13/13) after pulling. Pin is already
at `6c1bc9916472f23dcf237f5634f3ff33baff45e9` — the sibling `soa-validate`
repo pins the same commit, so impl and validator are in lockstep on
the same spec. No further bump required to close Week 0; next commit
begins Week 1 (trust bootstrap + Agent Card).
