# Deploying `@soa-harness/memory-mcp-sqlite`

SQLite-backed Memory MCP. Zero external services. In-process.
Recommended default for new agents (matches `create-soa-agent@1.0.0-rc.3+`
scaffold default).

## Two deployment shapes

### 1. Bundled with the Runner (create-soa-agent default)

`create-soa-agent <name>` scaffolds a project that boots a Memory MCP
on `:8001` in the same Node process as the Runner. Nothing to deploy
separately.

```
npx create-soa-agent@next myagent        # --memory=sqlite is default
cd myagent
npm install
npm start   # Runner on :7700 + memory-mcp-sqlite on :8001
```

### 2. Standalone HTTP service

Run the Memory MCP as its own long-lived process when you want to share
it across multiple Runner instances or manage its lifecycle
independently.

```
npm install -g @soa-harness/memory-mcp-sqlite
SOA_MEMORY_MCP_SQLITE_DB=/var/lib/soa/memory.sqlite \
SOA_MEMORY_MCP_SQLITE_SCORER=naive \
PORT=8005 HOST=127.0.0.1 \
soa-memory-mcp-sqlite
```

Or in Docker:

```
docker run -d --name soa-memory \
  -p 127.0.0.1:8005:8005 \
  -v soa-memory-data:/data \
  -e SOA_MEMORY_MCP_SQLITE_DB=/data/memory.sqlite \
  ghcr.io/wleeb1010/memory-mcp-sqlite:1.0.0-rc.0
```

Point Runners at it via `SOA_RUNNER_MEMORY_MCP_ENDPOINT=http://memory-host:8005`.

## Scorer providers

| Provider | When to use | Install |
|---|---|---|
| `naive` (default) | CI, low-footprint, deterministic results | no extra install |
| `transformers` | semantic search, opt-in | `npm install @huggingface/transformers` + `SOA_MEMORY_MCP_SQLITE_SCORER=transformers` |

MiniLM downloads on first use (~22 MB). Cache is reused on restart.
Cold-start timing is tracked as L-56 Gate 5; see
`docs/m5/gate-results.md`.

## Fault injection (test-only)

| Env var | Effect |
|---|---|
| `SOA_MEMORY_MCP_SQLITE_TIMEOUT_AFTER_N_CALLS` | hang on call N+1 (HR-17 substrate) |
| `SOA_MEMORY_MCP_SQLITE_RETURN_ERROR=<tool>` | named tool returns `{error:"mock-error"}` |
| `SOA_MEMORY_MCP_SQLITE_SEED=<path>` | pre-load corpus fixture for tests |

Never expose these to untrusted principals; bind to loopback by default.

## Package reference

Full env surface + endpoint table: see the package README at
[`packages/memory-mcp-sqlite/README.md`](../../packages/memory-mcp-sqlite/README.md).
