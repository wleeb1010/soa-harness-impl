# M5 Phase 0 — Gate Results

**Date:** 2026-04-23
**Spec pin:** 28e6460 (L-56 + §8.7 + backend-conformance-report.schema)
**Impl HEAD:** after `M5 Phase 0a: memory-mcp-mock §8.1 drift fix` + `M5 Phase 0b: CI scaffolding`

## Summary

| Gate | Status | Notes |
|---|---|---|
| Phase 0a — mock drift fix | ✅ PASS | `da41773` — 4 tools → 6 tools, +5 tests, 870/870 green |
| Phase 0b — CI scaffolding | ✅ PASS | workflow + `release-gate.mjs` + 4/4 gate smoke tests green |
| Gate 3 — mem0 deterministic mode | 🔜 DEFERRED | requires mem0 SDK install + LLM-extraction toggle validation; out-of-env for impl session |
| Gate 4 — Zep schema mapping | 🔜 DEFERRED | requires docker-compose Zep instance; out-of-env for impl session |
| Gate 5 — transformers.js cold-start | 🔜 DEFERRED | requires MiniLM model download + cold-cache timing on Windows + WSL2; out-of-env for impl session |
| Gate 6 — license audit baseline | ✅ PASS | `docs/m5/license-audit-current.txt`; zero forbidden licenses across 6 dep trees |

## Gate 6 detail

Run `license-checker-rseidelsohn --production --summary` against all six
package trees (@soa-harness/core, /schemas, /runner, /create-soa-agent,
/langgraph-adapter + tools/memory-mcp-mock). Aggregate:

- **Apache-2.0:** 25 entries
- **MIT:** 20 entries
- **UNLICENSED:** 1 entry — the mock package itself (`private: true`
  suppresses license-checker from reading the `"license": "Apache-2.0"`
  field; false positive, not a license compliance failure)
- **GPL / AGPL / BSL / SSPL / BUSL:** 0 entries across the full tree

Meets L-56 Gate 6 rule: only Apache-2.0 / MIT / BSD-\* / ISC permitted.

Backends (sqlite / mem0 / zep) will add their own `license-audit-<backend>.txt`
alongside this baseline when each package lands in Phase 1+.

## Gates 3, 4, 5 — deferred to a hands-on environment

These three gates require runtime resources this impl session can't
provision cleanly:

- **Gate 3 (mem0 determinism)** — needs `mem0` SDK installed, LLM
  extraction disabled (`inference_enabled=false` or equivalent), two
  consecutive runs of a pinned 20-note corpus, byte-equality assertion
  via ajv against `schemas/memory-search-response.schema.json`.
- **Gate 4 (Zep schema mapping)** — needs a docker-compose Zep
  instance, one POST via Zep SDK, a ≤300-LOC shim reshaping Zep's
  native response to §8.1 hit shape, ajv validation across sampled
  responses.
- **Gate 5 (transformers.js cold-start)** — needs clean Windows 11 +
  WSL2 Ubuntu with cold npm cache, three options evaluated in
  preference order: (a) pre-cache MiniLM-L6 in sqlite package tarball
  (≤25 MB tarball add, ≤90s cold install), (b) MiniLM-L3 fallback
  (≤10 MB) with SV-MEM-03..05 composite-score re-validation, (c) first-
  call timeout extension to 5000ms with revert to 2000ms post-warm-up.

Recommended routing: fold these into a follow-on spike session with
Docker + Python available. This impl session can continue with Phase 1
sqlite backend implementation in parallel IF sqlite doesn't block on
transformers.js cold-start — see the Phase 1 scoping note in L-56.

## Rollback decisions

No rollbacks fire from the work completed in this session. Phase 0a +
0b land clean; Gate 6 baseline is green. Gates 3/4/5 rollback triggers
evaluated only after those gates run.

## Next action

Deliver this doc + `license-audit-current.txt` back to spec-session.
No spec change required from the impl-side work here. Spec-session
may commit L-57 if Gates 3/4/5 introduce rollbacks after their hands-on
run; otherwise M5 progresses to Phase 1 sqlite backend implementation
on the impl side.
