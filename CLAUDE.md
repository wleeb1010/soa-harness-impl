# Claude Code Instructions — SOA-Harness Reference Implementation (TypeScript Monorepo)

## What this repo is

TypeScript/Node monorepo implementing the Core, Core+SI, and Core+Handoff profiles of SOA-Harness v1.0. This is the reference implementation — it stays **one step behind the spec**: when `soa-harness-specification` changes, this repo bumps a pinned digest; it does not co-author normative text.

Sibling repos:
- `../soa-harness=specification/` — normative spec, test vectors, must-maps, schemas
- `../soa-validate/` — Go conformance harness (separate repo by design to prevent self-proving)

## MCP servers available

Route spec questions and code-structure questions to different servers. **Prefer MCP over grep** for any structural question.

### `graphify-spec` (user-level, already configured)
Query this for anything about:
- Spec sections (`§N.M`), their content, their citations
- Test IDs (`SV-*`, `UV-*`, `HR-*`) and which MUSTs they cover
- Threat-model entries, trust-class mappings, closed-set error codes
- Cross-document relationships (Core ↔ UI), rationale paragraphs
- Load-bearing sections (use `god_nodes` to find high-impact change points before editing a component)

Example queries during implementation:
- Implementing CRL cache? → `query_graph(q='CRL')` returns §10.6.1, §7.3.1, §25.3 + every test ID that validates it
- Implementing PDA verification? → `get_neighbors(node='ui_section_11_4')` returns the full normative context in one hop
- Need to know what's normatively required for Agent Card? → `get_community` on the Agent Card node returns the §6 cluster + dependencies

### `graphify-impl` (this repo's doc + citation graph)
Query this for questions about:
- Which docs in this repo reference a spec section or test ID (`/logs/system/recent` refs, STATUS.md citations, plan-doc dependencies)
- Cross-repo file references (when a doc points at `soa-harness-specification/...` or `soa-validate/...`)
- Heading structure across all tracked docs (README/CLAUDE/STATUS/CONTRIBUTING/COORDINATION/docs/**/*.md/packages/*/README.md/docs/plans/*.md)
- Orphan docs (no inbound citation — candidates for pruning or cross-linking)

Example queries:
- "Which docs mention §10.6.2?" → `query_graph` on that spec-section node returns every impl doc citing it
- "What touches HR-02?" → `get_neighbors(node='test_hr_02')` returns the docs discussing that test
- "Which plans reference the handler CRL?" → `query_graph` on the handler CRL heading returns all inbound doc citations

### `CodeGraphContext` (per-project, auto-indexes this repo)
Query this for questions about:
- TypeScript code structure within this monorepo
- Cross-package imports, function-call chains, dead code
- `find_code`, `find_most_complex_functions`, `analyze_code_relationships`

**Routing rule:** for "what docs reference X?" questions, query `graphify-impl`. For "what does spec section X say?" or "which spec tests cover X?", query `graphify-spec`. For TS code structure, query `CodeGraphContext`. **Prefer MCP over grep** for any of these.

## Code-generation guardrails

When you write code in this repo:

1. **Crypto-sensitive paths require two-reviewer approval.** See `CODEOWNERS`. Paths: `packages/core/`, `packages/runner/src/audit/`, `packages/runner/src/session/`, any PDA/JWS/JCS signing code. Flag PRs touching these so a reviewer knows to request a second pair of eyes.

2. **Never reimplement JCS.** Use `canonicalize`. The integer-only `jcs()` in spec-repo `build-manifest.mjs` is a test-vector helper, NOT a production primitive. Wrapping in `packages/core/src/jcs.ts` is fine; reimplementing the algorithm is a red flag.

3. **Never hand-roll JWS.** Use `jose`. All sign/verify goes through that library.

4. **Test vectors are authoritative.** When implementing a signing path, the test comes from `../soa-harness=specification/test-vectors/` at the pinned digest in `soa-validate.lock`. If your impl disagrees with the vector, the impl is wrong.

5. **Spec pinning.** `soa-validate.lock` records the spec MANIFEST SHA this impl targets. Bumping the pin is a deliberate, reviewable action — never silent.

6. **Closed enums are closed.** StreamEvent types (`§14.1` — 25 values), error codes (§24 / UI §21 taxonomy), `trust_class` values — these are all closed enums. Adding a new value is a spec change, not a PR to this repo.

## Milestone discipline

We ship milestones by literal test-ID count, not by subjective completeness. See the roadmap plan in `~/.claude/plans/`. M1 exit is the 8 test IDs `{HR-01, HR-02, HR-12, HR-14, SV-SIGN-01, SV-CARD-01, SV-BOOT-01, SV-PERM-01}`. Anything outside that list in M1 is scope creep.

## Testing philosophy

- Unit tests use Vitest (fast, ESM-native, Jest-compatible)
- Integration tests spin real Runner instances against test vectors
- JCS parity tests (`packages/core/test/parity/`) run Go `canonicaljson-go` via `execa` and compare bytes — **critical invariant**, do not skip

## Before opening a PR

- `pnpm -r build` — green
- `pnpm -r test` — green
- `pnpm -r lint` — green
- `pnpm typecheck` — green
- If touching crypto paths, @-mention the second reviewer in `CODEOWNERS`

## Parallel Claude Code sessions

You may be running alongside a sibling session in `../soa-validate/` (and occasionally in `../soa-harness=specification/`). Each session has its own task list and memory — **nothing crosses session boundaries automatically**.

**Before making a change, ask yourself: does this affect a contract the sibling repo depends on?**

Contracts that cross session boundaries:
- The Runner's HTTP API (port, endpoints, request/response schemas) — validator tests against this
- Wire formats for signed artifacts (Agent Card, PDA, MANIFEST) — validator verifies these
- StreamEvent enum values and payload schemas — validator asserts the closed set
- JCS parity vectors (consumed from `../soa-harness=specification/test-vectors/jcs-parity/`)

For contract changes: open a GitHub issue on THIS repo, cross-reference a matching issue on `soa-validate`, wait for sibling acknowledgment before merging. See `COORDINATION.md` for the full protocol.

**Always-safe changes** (no coordination required): package-internal refactoring, unit tests that don't change observable behavior, internal logging, bug fixes that bring behavior INTO alignment with the spec (vs. away from it).

## Session startup context

On first session start in this repo, read in this order:
1. `CONTEXT.md` — condensed summary of where we are, what's been decided, what ships next
2. `docs/plans/m1.md` — the M1 tactical plan (authoritative, lives in this repo, versioned with the code)
3. `~/.claude/plans/put-a-plan-together-glittery-hartmanis.md` — the full roadmap across all three repos
4. `soa-validate.lock` — which spec commit we're targeting

Older note: `~/.claude/plans/soa-harness-impl-m1.md` may exist as a user-level convenience copy. If it disagrees with `docs/plans/m1.md`, the repo-local file is authoritative.

`graphify-spec` MCP is already registered and connected (user level). Use it freely for spec questions.
