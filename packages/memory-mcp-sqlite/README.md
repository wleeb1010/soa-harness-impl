# `@soa-harness/memory-mcp-sqlite`

SQLite-backed Memory MCP implementing the SOA-Harness §8.1 six-tool
protocol. Zero external services — `better-sqlite3` in-process,
optional MiniLM embeddings via `@huggingface/transformers`, local
file-based persistence.

## Install

```
npm install @soa-harness/memory-mcp-sqlite
```

## Run

```
npx soa-memory-mcp-sqlite
```

Environment:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8005` | HTTP port |
| `HOST` | `127.0.0.1` | bind host (loopback-only) |
| `SOA_MEMORY_MCP_SQLITE_DB` | `./soa-memory.sqlite` | path to the SQLite DB file |
| `SOA_MEMORY_MCP_SQLITE_SCORER` | `naive` | `naive` (substring+recency+graph) or `transformers` (MiniLM) |
| `SOA_MEMORY_MCP_SQLITE_SEED` | — | optional path to a `corpus-seed.json` for test fixtures |
| `SOA_MEMORY_MCP_SQLITE_TIMEOUT_AFTER_N_CALLS` | — | fault-injection; after N successful calls, hang forever |
| `SOA_MEMORY_MCP_SQLITE_RETURN_ERROR` | — | fault-injection; named tool returns `{error:"mock-error"}` |

## Endpoints (§8.1 six tools)

```
POST /search_memories          { query, limit?, sharing_scope? }        → { hits }
POST /search_memories_by_time  { start, end, limit? }                   → { hits, truncated }
POST /add_memory_note          { summary, data_class, session_id, note_id? } → { note_id }
POST /read_memory_note         { id }                                   → { id, note, tags, importance, created_at, graph_edges } | { error:"MemoryNotFound", id }
POST /consolidate_memories     { consolidation_threshold? }             → { consolidated_count, pending_count }
POST /delete_memory_note       { id, reason? }                          → { deleted, tombstone_id, deleted_at } (idempotent on id)
GET  /health                                                            → { status:"alive" }
```

## Scoring providers

The `search_memories` composite score comes from a pluggable
`Scorer`. Two providers ship; pick one with
`SOA_MEMORY_MCP_SQLITE_SCORER`.

- **`naive` (default)** — substring + recency + graph-strength
  composite. Deterministic, zero cold-start, matches
  `memory-mcp-mock` scoring so SV-MEM-01..08 pass without a model
  file. Recommended for CI, low-footprint deployments, and reference-
  implementation installs.
- **`transformers` (opt-in)** — MiniLM-L6-v2 cosine similarity via
  `@huggingface/transformers` (listed as an `optionalDependency` so
  the default install stays lean). To enable semantic search:

  ```
  npm install @huggingface/transformers
  SOA_MEMORY_MCP_SQLITE_SCORER=transformers soa-memory-mcp-sqlite
  ```

  The MiniLM model (~22 MB) downloads on first use; the cache is
  reused on subsequent boots. Cold-start timing on Windows + WSL2 is
  tracked as L-56 Gate 5 (deferred pending hands-on verification).

## Fault-injection hooks

Mirror `memory-mcp-mock`'s `SOA_MEMORY_MCP_MOCK_*` triad so the
validator's SV-MEM-03/04/HR-17 probes run unmodified against this
backend. See `src/env.ts` for the env-parsing entry point.
