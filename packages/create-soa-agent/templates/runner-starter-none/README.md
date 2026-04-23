# Demo SOA-Harness agent

Scaffolded by `create-soa-agent`. Ships a Runner + ReadOnly Agent Card +
minimal Tool Registry + illustrative PreToolUse hook.

## Running

Two modes depending on how this demo was scaffolded:

### In-monorepo (`create-soa-agent ... --link`)

The demo lives under `<monorepo>/examples/<name>/` and joins the pnpm
workspace. Dependencies resolve via `workspace:*` linkage — you MUST
use pnpm, not npm.

```
cd <monorepo>        # root containing pnpm-workspace.yaml
pnpm install         # picks up the new examples/* member
cd examples/<name>
pnpm start           # runs node ./start.mjs
```

### Standalone (default — available after @soa-harness/* packages are npm-published)

```
cd <scaffolded-dir>
npm install          # resolves @soa-harness/runner from npm
npm start
```

Until the packages are npm-published (tracked as Phase 0e E3), the
standalone mode will fail with `EUNSUPPORTEDPROTOCOL workspace:*`.
Use `--link` for now.

The Runner serves:

- `GET /.well-known/agent-card.json` + `.jws`
- `GET /health`, `GET /ready`
- `GET /audit/tail`, `GET /audit/records`
- `GET /permissions/resolve?tool=<n>&session_id=<id>`
- `POST /sessions` (fixed bootstrap bearer from `SOA_RUNNER_BOOTSTRAP_BEARER`)
- `POST /permissions/decisions`

Self-signed keys live in `initial-trust.json` — LOUDLY not production-safe.
Rotate before deploying anywhere other than your laptop.

## First audit row

`start.mjs` drives one `POST /permissions/decisions` against the pre-built
`permission-decisions/auto-allow.json` body after the Runner becomes ready,
so a `GET /audit/tail` returns `record_count: 1` within a few seconds of
`node ./start.mjs`.

That's the deterministic time-to-first-row measurement that
`create-soa-agent-demo` in CI exercises.
