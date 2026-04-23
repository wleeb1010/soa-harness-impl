# Credential Sweep — trufflehog3 — soa-harness-impl

M6 Phase 0d (L-60 in spec repo). Result of the mandatory pre-release credential scan.

## Result

**Zero HIGH severity findings outside third-party / build-artifact paths.**

Raw scan: 48 HIGH findings total, all located in:
- `node_modules/.pnpm/cloudflare@4.5.0/node_modules/cloudflare/resources/**/*.{d.ts,js,mjs}` — RSA private-key EXAMPLES embedded in Cloudflare SDK JSDoc comments. Not production keys; they're `-----BEGIN RSA PRIVATE KEY-----` blobs shown as literal documentation of what a Cloudflare API payload looks like.

After filtering by path (excluding `node_modules/`, `dist/`, `build/`, `.pnpm/`, `graphify-out/`, `logs/`, `.git/`), the real-findings count is **0**.

## Why the Cloudflare false positives are safe

These files are vendored third-party code. The RSA keys in them are:
- Documentation-only (inside JSDoc `@example` blocks)
- Identical byte-for-byte across multiple files (same example key reused)
- Part of a widely-audited public npm package (`cloudflare`), no indicator of tampering
- Never executed as signing material — they're string literals in docstrings

A scan hitting `node_modules` false-positives is expected for any Node.js project that depends on a major API SDK. The real-signal path is everything OUTSIDE `node_modules`.

## Scan commands

```bash
# Full HIGH-severity scan
python -m trufflehog3 -z --severity HIGH --format JSON -o /tmp/impl-scan.json .

# Filter out node_modules / build / pnpm noise
python ../soa-harness=specification/scripts/filter-trufflehog.py /tmp/impl-scan.json
```

Exit 0 with `-z` flag; filter script reports 0 real findings.

## Future scans

Developers and CI should run the same two-step (scan + filter) to catch any new finding outside the excluded paths. Any new real finding is a real signal; investigate before committing.

Since trufflehog3's config schema is strict, the cleaner pattern is:
1. Always scan with `-z` (zero exit) + JSON output
2. Post-filter in Python using the shared `scripts/filter-trufflehog.py` from the spec repo

## Reference

- Spec repo `docs/m6/credential-sweep-results.md` — equivalent baseline for the spec repo (also zero real HIGH findings)
- Spec repo `scripts/filter-trufflehog.py` — the shared path-filter
- L-60 Phase 0d — parent milestone record
