# Context — soa-harness-impl

> **Read this file before doing anything in a fresh Claude Code session.** It condenses what a previous session (and the spec authors) already decided, so you don't have to re-derive it.

## Where we are

**Date:** 2026-04-20
**Status:** Pre-M1 scaffold. No functional code. Repo has: Apache 2.0 LICENSE, README, CLAUDE.md, CONTRIBUTING.md, CODEOWNERS, COORDINATION.md, soa-validate.lock.

**Siblings:**
- `../soa-harness=specification/` — normative spec. Through 4 rounds of structural audit + external OpenAI and Grok reviews. Latest commit: `559dec8588441bc29639190870e4541146242b90`.
- `../soa-validate/` — Go conformance harness. Same scaffold state as this repo.

## What was decided (and why)

### 1. Three separate repos, not one monorepo
- Spec, impl, validator are each independently authored and reviewed
- Same-author-all-three would invalidate "conformant" claims — the validator must be independent
- Plan file `~/.claude/plans/put-a-plan-together-glittery-hartmanis.md` documents the full rationale

### 2. TypeScript for Runner + Gateway, Go for the validator
- Spec's Gateway reference sketch is already TS/Fastify — reusing establishes pattern continuity
- Spec explicitly endorses `canonicalize` (TS) and `gowebpki/jcs` (Go) for JCS
- `jose` (TS) is the mature JWS library in this ecosystem
- `ajv` handles JSON Schema 2020-12 validation

### 3. JCS cross-language byte-equivalence is the #1 load-bearing invariant
- If TS and Go canonicalize differently, every signed artifact silently fails cross-verification
- **Week 0 parity harness runs before any signed-artifact code** — `packages/core/test/parity/ts-vs-go.test.ts`
- Vectors live in spec repo at `test-vectors/jcs-parity/` (consumed by both impl and validate at pinned commit)

### 4. M1 is 6 weeks, 8 test IDs, no crash recovery
Literal test IDs that gate M1 exit:
```
{HR-01, HR-02, HR-12, HR-14, SV-SIGN-01, SV-CARD-01, SV-BOOT-01, SV-PERM-01}
```
**Anything outside this list is M1 scope creep.**

Crash-safe session persistence is its own M2 milestone (+2 weeks) because Windows `MoveFileExW(WRITE_THROUGH)` vs POSIX `fsync+rename+dir-fsync` divergence is genuinely hard.

### 5. Milestone breakdown
| M# | Duration | Scope |
|---|---|---|
| Phase 0 | Done | Repos created, MCPs registered, governance docs, plan approved |
| Week 0 | 1w | JCS parity harness, repo ops prerequisites |
| M1 | 6w | 8 test IDs pass, `npx create-soa-agent` works in < 90s on cold CI cache |
| M2 | +2w | HR-04, HR-05, SV-SESS-01 (crash-safe persistence, platform matrix) |
| M3 | +4w | Gateway + soa-validate v1.0 + Memory (§8) + Budget (§13); 120/150 test target |
| M4 | +3w | LangGraph adapter, adoption gate (15-min reviewer onboarding), CrewAI stretch |
| M5 | +6w | Core+SI + Core+Handoff + independent crypto review + conformance label split |

### 6. Conformance label strategy (dual track)
- **"SOA-Harness v1.0 Reference Implementation"** — self-assigned after passing 213 tests against a pinned spec commit
- **"SOA-Harness v1.0 Bake-Off Verified"** — requires a second-party implementation to converge with zero divergence

This split unblocks M5 even if no second-party impl materializes.

## Technical decisions already made (don't relitigate)

| Decision | Choice | Why |
|---|---|---|
| HTTP framework | `fastify` | Matches Gateway sketch; `onSend` hooks work for HSTS/CSP; TLS 1.3 `minVersion` + `requestCert` idiomatic |
| JWS | `jose` | Production-grade, actively maintained, handles EdDSA/ES256/RS256 |
| JSON Schema | `ajv` with 2020-12 plugin | Best-in-class for this draft |
| JCS | `canonicalize` | Only production-grade TS RFC 8785 implementation |
| Test runner | `vitest` | ESM-native, fast, Jest-compatible |
| Monorepo | `pnpm` workspaces | Standard, supports per-package publishing |
| Demo keystore | Software keystore with warning | `keytar` pulls `node-gyp` which kills 90-second demo budget on Windows |
| Package distribution | npm only (M1) | Degit starter eliminated until user demand justifies it |

## What OpenAI and Grok flagged (already addressed in spec)

- ✅ A2A version pin too narrow → spec §19.4.3 Upstream Horizon clause
- ✅ MCP URL potentially 404 → spec §2 drift policy, digest-not-URL normative identity
- ✅ Placeholder MANIFEST signature → README Status banner added
- ✅ License missing → Apache 2.0 added (spec LICENSE pending commit; impl/validate have it)
- ✅ "SOA-WG" aspirational → GOVERNANCE.md acknowledges single-maintainer status honestly
- ✅ `data_class=restricted` not in enum → changed to actual enum values
- ✅ "Full" profile undeclared in §18.3 → now declared

## What graphify-spec MCP gives you (at query time)

- 500 nodes / 880+ edges across spec
- Every §N section as a node
- Every cross-reference as an edge (cites, references)
- Every test ID as a node with `validated_by` edges to the §s it covers
- Rationale paragraphs linked to the §s they justify
- Threat-model entries (§25.3) linked to the §s they protect
- Community structure revealing load-bearing sections (god nodes)

Use this instead of grep for:
- "Which sections require X?"
- "What does test ID Y validate?"
- "Is section Z load-bearing? What cites it?"
- "What's the threat-model coverage for this primitive?"

## If you're starting fresh in this repo

1. Verify `claude mcp list` shows `graphify-spec` connected
2. Read `CLAUDE.md` in this repo for routing instructions
3. Read `~/.claude/plans/soa-harness-impl-m1.md` for the tactical plan
4. Check `../soa-harness=specification/` is at commit `559dec8` (or later with a matching `soa-validate.lock` bump)
5. Start with Week 0 work — JCS parity harness before anything else
