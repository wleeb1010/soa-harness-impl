# Status — soa-harness-impl

## 2026-04-20

- **Done:** Week 0 Day 1 repo wiring (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, 4 package skeletons: `@soa-harness/core`, `@soa-harness/schemas`, `@soa-harness/runner`, `create-soa-agent`). CI workflow (`.github/workflows/ci.yml`) with Node 20 matrix on Ubuntu/macOS/Windows, checks out spec sibling at pinned commit before build. Week 0 Day 4 schemas package: `scripts/build-validators.mjs` reads `soa-validate.lock`, verifies sibling at pinned spec (currently `b1497025`), vendors 14 schemas, compiles standalone Ajv 2020-12 validators, emits typed registry. Smoke tests (4) green.
- **Active:** Week 0 Day 2-3 (JCS parity harness) deferred until the spec-repo generator has been run against the pinned commit and `test-vectors/jcs-parity/generated/` is populated. Week 0 Day 5 (`@soa-harness/core` digest + tasks-fingerprint + JCS wrapper) not yet started.
- **Blocked:** `test-vectors/jcs-parity/generated/` is empty at spec commit `b1497025`. The parity harness (Day 2-3) needs the sibling validate/spec session to run `generate-vectors.mjs` and commit the outputs so we can consume them at the pinned commit. No cross-repo contracts changed — all work so far is package-internal.

Local verification: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` all green on Windows (Node v22.19.0, pnpm 10.33.0).
