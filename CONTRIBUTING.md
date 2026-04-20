# Contributing to soa-harness-impl

## Sign-off required

All commits MUST include a Developer Certificate of Origin (DCO) sign-off. Use `git commit -s` or add the trailer manually:

```
Signed-off-by: Your Name <your.email@example.com>
```

CI rejects PRs with unsigned commits.

## Crypto-sensitive paths (two reviewers required)

PRs that touch any of these paths require approval from **two** reviewers listed in `CODEOWNERS`:

- `packages/core/src/jcs.ts` — JSON canonicalization (RFC 8785)
- `packages/core/src/digest.ts` — SHA-256 helpers
- `packages/core/test/parity/` — cross-language canonicalization parity tests
- `packages/runner/src/audit/` — WORM hash-chained audit sink
- `packages/runner/src/session/` — atomic session persistence
- Anything implementing JWS signing or verification
- Anything touching the `canonical_decision` PDA path

Tag such PRs `[CRYPTO]` in the title so reviewers can prioritize.

## Non-crypto PRs

One reviewer approval + green CI is sufficient.

## Required CI checks before merge

- `pnpm -r build` — green across all packages
- `pnpm -r test` — green unit + integration tests
- `pnpm -r lint` — no warnings
- `pnpm typecheck` — no errors
- `packages/core/test/parity/ts-vs-go.test.ts` — TS/Go JCS byte-equivalence passes

## What NOT to do

- **Never hand-roll JCS or JWS.** Use `canonicalize` and `jose`. Reimplementing these primitives is a security risk and is explicitly out of scope for this repo.
- **Never modify files in `soa-harness-specification/`.** The spec is the source of truth. If a normative change is needed, it goes to the spec repo first, then this repo bumps `soa-validate.lock`.
- **Never co-release with the spec.** Spec changes land first. This repo's next release pins to the new spec MANIFEST digest as a separate, reviewable action.
- **Never generate expected test values.** Expected values (digests, signatures, canonical bytes) come from spec test vectors at the pinned MANIFEST. If you need to compute one in this repo, the architecture is wrong.

## Bug reports and feature requests

GitHub Issues on this repo. Use the templates.

## Security reports

Do not open public issues for security vulnerabilities. Use GitHub Security Advisories (private) on this repo. Acknowledgment within 72 hours.

## License and IPR

By contributing, you agree your contributions are licensed under Apache 2.0 (same as the repo). The DCO sign-off is the formal attestation of that agreement.

No Contributor License Agreement (CLA) is required at this time. If the project later forms a foundation (CNCF / OpenJS / LF), we may migrate to a CLA — contributors will be notified before any such migration.
