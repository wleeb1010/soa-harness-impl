# Demo SOA-Harness agent

Scaffolded by `create-soa-agent`. Ships a Runner + ReadOnly Agent Card +
minimal Tool Registry + illustrative PreToolUse hook.

## Running

```
npm install
node ./start.mjs
```

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
