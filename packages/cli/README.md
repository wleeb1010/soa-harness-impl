# @soa-harness/cli

`soa` command-line client for SOA-Harness v1.2 Runners. Wraps the HTTP surface so operators can chat, check status, tail audit logs, and drive conformance without hand-authoring fetch() calls.

## Install

```bash
npm install -g @soa-harness/cli
# or: npx @soa-harness/cli@latest --help
```

## Quick start

```bash
# Health/readiness/version summary
soa status --runner-url http://localhost:7700

# Tail the audit log
export SOA_RUNNER_URL=http://localhost:7700
export SOA_SESSION_BEARER=$MY_BEARER
soa audit tail

# Interactive streaming chat
soa chat --session-id ses_... --model example-adapter-model-id

# Run the conformance suite (wraps soa-validate binary)
soa conform --profile core
```

## Commands

### `soa status`

One-shot `/health` + `/ready` + `/version` probe plus (if bearer provided) the latest audit-row timestamp. Prints JSON. Exits 0 on alive+ready, 1 otherwise. Safe for CI smoke tests and `docker-compose` healthcheck.

### `soa audit tail`

Polls `/audit/tail` every 3s (configurable via `--poll-interval-ms`) and prints new rows as they arrive. `--format json` emits one JSON object per line; `--format pretty` (default) is a human-readable timestamp + kind + stop_reason summary. Ctrl-C exits cleanly.

### `soa chat`

Interactive streaming-dispatch REPL. Each prompt is sent as a `POST /dispatch` with `Accept: text/event-stream` per §16.6.2; `ContentBlockDelta.text` chunks stream to stdout as they arrive. Ctrl-C mid-stream fires `POST /dispatch/{correlation_id}/cancel` per §16.6.4; Ctrl-D quits.

Minimal REPL (no ink/blessed) — adopters wanting fancier TUIs compose `RunnerClient.dispatchStream()` directly.

### `soa conform`

Thin wrapper around the `soa-validate` Go binary. Runs the default `--profile core` invocation with sensible defaults for `--impl-url` / `--spec-vectors` / `--out`. If `soa-validate` isn't on PATH, prints the install command and exits 2.

## Environment variables

| Variable | Purpose |
|---|---|
| `SOA_RUNNER_URL` | Default for `--runner-url`. |
| `SOA_SESSION_BEARER` | Default for `--session-bearer`. |
| `SOA_ADMIN_BEARER` | Default for `--admin-bearer`. |

## Library use

The CLI's internals — `RunnerClient`, the command functions, the SSE parser — are exported for downstream programmatic use:

```typescript
import { RunnerClient, statusCommand } from "@soa-harness/cli";

const client = new RunnerClient({
  runnerUrl: "http://localhost:7700",
  sessionBearer: process.env.SOA_SESSION_BEARER!,
});
const version = await client.getVersion();
console.log(version.spec_commit_sha);
```

## Scope for v1.2

Direct-to-Runner only — no Gateway (that's M11). No OAuth flow. One session per invocation. Adopters with multi-session or Gateway-mediated workflows build on `RunnerClient` + their own session orchestration.
