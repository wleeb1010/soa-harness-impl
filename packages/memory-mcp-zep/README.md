# `@soa-harness/memory-mcp-zep`

Zep-backed Memory MCP implementing the SOA-Harness §8.1 six-tool
protocol. The shim maps Zep's Document Collection API to §8.1's
canonical hit shape (≤300 LOC per L-56 Gate 4 constraint).

Wire-compatible with `@soa-harness/memory-mcp-sqlite` and
`@soa-harness/memory-mcp-mem0`.

## Install

```
npm install @soa-harness/memory-mcp-zep
```

## Run

Bring up Zep v0.27.2 (+ Postgres + NLP server) then the shim:

```
docker compose -f node_modules/@soa-harness/memory-mcp-zep/docker-compose.yml up -d
npx soa-memory-mcp-zep
```

Zep is **not on Docker Hub** — the container image comes from
`ghcr.io/getzep/zep:latest` (Apache-2.0 per image label). The
docker-compose file wires this for you. The NLP server bundles
MiniLM-class local embeddings; no OpenAI key required for the §8.1
document-collection path.

### Env surface

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8007` | HTTP port |
| `HOST` | `127.0.0.1` | bind host (loopback-only by default) |
| `ZEP_URL` | `http://localhost:8003` | Zep server endpoint |
| `SOA_MEMORY_MCP_ZEP_COLLECTION` | `soamemmcpzep` | Zep collection name (Zep rejects underscores — keep alphanum) |
| `SOA_MEMORY_MCP_ZEP_TIMEOUT_AFTER_N_CALLS` | — | fault-injection; after N successful calls, hang forever |
| `SOA_MEMORY_MCP_ZEP_RETURN_ERROR` | — | fault-injection; named tool returns `{error:"mock-error"}` |
| `SOA_MEMORY_MCP_ZEP_SEED` | — | optional corpus seed path |

### Endpoints (§8.1 six tools)

```
POST /search_memories          { query, limit?, sharing_scope? }            → { hits }
POST /search_memories_by_time  { start, end, limit? }                       → { hits, truncated }
POST /add_memory_note          { summary, data_class, session_id, note_id?, tags?, importance? } → { note_id, created_at }
POST /read_memory_note         { id }                                       → { id, note, tags, importance, created_at, graph_edges } | { error:"MemoryNotFound", id }
POST /consolidate_memories     { consolidation_threshold? }                 → { consolidated_count, pending_count }
POST /delete_memory_note       { id, reason? }                              → { deleted, tombstone_id, deleted_at } (idempotent on id)
GET  /health                                                                → { status:"alive" }
```

## Sensitive-personal filter (§10.7.2 + §8.1 L-58)

Requests with `data_class="sensitive-personal"` are rejected before any
bytes reach Zep and return
`{error:"MemoryDeletionForbidden", reason:"sensitive-class-forbidden"}`.
Zep's server does not enforce this natively — the shim does.

## SDK quirks (documented in the shim)

Surfaced during the L-56 Gate 4 feasibility spike:

- **`@getzep/zep-js@0.10.0`'s `getDocument(uuid)` is broken** — it
  builds `/document/{uuid}` which the server 404s on. The server
  expects `/document/uuid/{uuid}`. The shim routes `read_memory_note`
  through `getDocuments([uuid])` (`/document/list/get` POST) which works.
- **Zep rejects collection names with underscores** (alphanum only).
  The default `soamemmcpzep` honors this.
- **Summarizer + entity extractors must be disabled** in Zep's
  `config.yaml` for the server to boot without an OpenAI key. The
  `docker-compose.yml` shipped here sets the right flags.
