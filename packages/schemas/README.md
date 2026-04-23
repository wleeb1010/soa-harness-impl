# @soa-harness/schemas

Runtime-compiled [Ajv 2020-12](https://ajv.js.org/) validators for
every JSON Schema shipped in the SOA-Harness specification bundle.

## Exports

- **`registry`** — `Record<SchemaName, ValidateFunction>` with every
  `$id`-addressable schema pinned to the spec commit. Key names match
  the schema filename minus the `.schema.json` suffix (e.g.
  `"agent-card"`, `"permission-decision-response"`).
- **`schemaNames`** — string array of all registered schema names.

## How it works

The schemas are vendored into `src/schemas/vendored/` (tracked in git;
ship as `dist/schemas/vendored/` in the npm tarball). At package load
time the validators are compiled by Ajv 2020-12 with
`ajv-formats` — compile cost is sub-millisecond per schema on modern
Node.

## Spec pin

The vendored schemas carry a `PINNED_COMMIT.txt` stamp with the exact
spec-repo SHA they came from. That SHA must match the monorepo's
`soa-validate.lock.spec_commit_sha`; mismatch triggers a re-vendor
from the sibling spec repo at build time (pin-bump workflow).

## License

Apache-2.0.
