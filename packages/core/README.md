# @soa-harness/core

Cryptographic primitives for the SOA-Harness reference implementation.

Small surface, deliberately. This package exposes only what the
Runner, adapter, and scaffold need across package boundaries —
anything more specialized lives in the consumer.

## Exports

- **JCS canonicalization** — thin wrapper around the
  [`canonicalize`](https://www.npmjs.com/package/canonicalize) npm
  package (RFC 8785, by Samuel Erdtman). Never reimplement JCS; always
  route through this wrapper.
- **Digest helpers** — SHA-256 over bytes and strings (for
  `args_digest`, MANIFEST entries, etc.).
- **tasks-fingerprint** — canonical fingerprint of a `/tasks/` bundle
  per §23 novelty quota (`SV-GOOD-07`).

## Spec pin

Paired with a specific SOA-Harness specification commit via
`soa-validate.lock` in the monorepo root. Cross-language JCS
byte-equivalence is asserted against `canonicaljson-go` via
`test-vectors/jcs-parity/` at that pin — do not skip those
integration tests in CI.

## License

Apache-2.0.
