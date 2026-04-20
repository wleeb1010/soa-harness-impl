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

### `CodeGraphContext` (per-project, auto-indexes this repo)
Query this for questions about:
- TypeScript code structure within this monorepo
- Cross-package imports, function-call chains, dead code
- `find_code`, `find_most_complex_functions`, `analyze_code_relationships`

## Code-generation guardrails

When you write code in this repo:

1. **Crypto-sensitive paths require two-reviewer approval.** See `CODEOWNERS`. Paths: `packages/core/`, `packages/runner/src/audit/`, `packages/runner/src/session/`, any PDA/JWS/JCS signing code. Flag PRs touching these so a reviewer knows to request a second pair of eyes.

2. **Never reimplement JCS.** Use `@filen/rfc8785`. The integer-only `jcs()` in spec-repo `build-manifest.mjs` is a test-vector helper, NOT a production primitive. Wrapping in `packages/core/src/jcs.ts` is fine; reimplementing the algorithm is a red flag.

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
