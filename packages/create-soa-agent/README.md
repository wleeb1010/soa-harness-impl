# create-soa-agent

`npx` scaffold that produces a runnable SOA-Harness demo agent — Runner on `:7700`, ReadOnly Agent Card, minimal tool registry, illustrative PreToolUse hook, auto-allow first permission decision.

Target: a user typing `npx create-soa-agent demo` gets to a green `/audit/tail` response in well under 90 seconds on a warm npm cache.

## Usage

```
npx create-soa-agent demo
cd demo
npm install
npm start
```

On a fresh machine expect a short cold-cache install phase (Runner transitive deps: Fastify, JOSE, x509, Ajv). The start script drives one permission decision against a pre-built auto-allow body, so `curl http://localhost:7700/audit/tail` returns `record_count: 1` within a few seconds of start.

### In-monorepo dev mode (`--link`)

Contributors working inside a clone of the SOA-Harness impl repo can skip the publish-registry round-trip and scaffold a demo that joins the pnpm workspace directly:

```
pnpm --filter=create-soa-agent exec node dist/cli.js demo --link
```

The scaffold lands under `<monorepo>/examples/<name>/` where the workspace's `examples/*` glob catches it. `workspace:*` deps resolve natively via pnpm linkage; use pnpm (not npm) inside examples/.

## What gets scaffolded

```
<project>/
  agent-card.json          — ReadOnly demo Card with freshly-generated SPKI
  initial-trust.json       — synthetic SDK-pinned trust root
  tools.json               — 3-tool demo registry
  hooks/pre-tool-use.mjs   — illustrative §15 hook
  permission-decisions/auto-allow.json
  start.mjs                — demo entrypoint (drives first audit row)
  AGENTS.md                — §7.2 agent-type constraints sample
  package.json
  README.md
```

The scaffold **generates a synthetic Ed25519 keypair + self-signed cert** for the demo SPKI. The private key is NOT persisted. Production deployments MUST supply an operator-issued key + cert chain (`RUNNER_SIGNING_KEY` + `RUNNER_X5C`).

## License

Apache-2.0.
