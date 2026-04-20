# Status — soa-harness-impl

## 2026-04-20

### PM update — Day 5 core helpers landed

- **Done:**
  - Week 0 Day 1 repo wiring (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, 4 package skeletons). CI workflow checks out sibling spec at pinned commit before build.
  - Week 0 Day 4 schemas package: `scripts/build-validators.mjs` vendors schemas from the pinned spec, compiles 14 standalone Ajv 2020-12 validators, emits typed registry. 4 smoke tests green.
  - Week 0 Day 5 `@soa-harness/core` helpers: `src/jcs.ts` (wrapper over Erdtman's `canonicalize`), `src/digest.ts` (`sha256Hex`, `digestJson`, `digestRawUtf8` ports), `src/tasks-fingerprint.ts` (port of spec's `compute.mjs`). 17 unit tests green locally — including a parity test against the spec's `test-vectors/tasks-fingerprint/` fixture that pins the expected fingerprint at the soa-validate.lock spec commit.
- **Active:** Nothing in-flight on our side. Week 1 (Trust bootstrap + Agent Card) is unblocked as soon as the parity vectors (Day 2-3) land.
- **Blocked:** Day 2-3 (JCS cross-language parity harness) waits for the sibling validate/spec session to run `generate-vectors.mjs` and commit `test-vectors/jcs-parity/generated/*.json` at a pinned commit. No contracts crossed — all core helpers are package-internal and match the spec's reference bit for bit.

Local verification: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` all green (21 tests passing) on Windows (Node v22.19.0, pnpm 10.33.0). Sibling spec repo pinned at `208e5dd`.
