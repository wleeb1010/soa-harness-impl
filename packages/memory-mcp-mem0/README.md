# `@soa-harness/memory-mcp-mem0`

mem0-backed Memory MCP implementing the SOA-Harness §8.1 six-tool
protocol. Qdrant vector store + OpenAI or local Ollama for
LLM/embeddings. Passes the SV-MEM-01/02/07/08 + STATE-01/02 conformance
probes against a real Runner.

## Install

```
npm install @soa-harness/memory-mcp-mem0
```

## Run

The package needs a running Qdrant instance (default `:6333`) and an
LLM + embedder provider. Ollama is the zero-egress default; OpenAI is
supported via `OPENAI_API_KEY`.

### Quickest path (docker-compose, Ollama-on-host)

```
docker compose -f node_modules/@soa-harness/memory-mcp-mem0/docker-compose.yml up -d
ollama pull llama3.1
ollama pull nomic-embed-text
npx soa-memory-mcp-mem0
```

### Env surface

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8006` | HTTP port |
| `HOST` | `127.0.0.1` | bind host (loopback-only by default) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant endpoint |
| `SOA_MEMORY_MCP_MEM0_PROVIDER` | `ollama` | `ollama` or `openai` |
| `OPENAI_API_KEY` | — | required when `SOA_MEMORY_MCP_MEM0_PROVIDER=openai` |
| `SOA_MEMORY_MCP_MEM0_COLLECTION` | `soa_mem0_notes` | Qdrant collection name |
| `SOA_MEMORY_MCP_MEM0_TIMEOUT_AFTER_N_CALLS` | — | fault-injection; after N successful calls, hang forever |
| `SOA_MEMORY_MCP_MEM0_RETURN_ERROR` | — | fault-injection; named tool returns `{error:"mock-error"}` |
| `SOA_MEMORY_MCP_MEM0_SEED` | — | optional corpus seed path |

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

Requests with `data_class="sensitive-personal"` are rejected **before
any bytes reach the mem0 LLM call** and return
`{error:"MemoryDeletionForbidden", reason:"sensitive-class-forbidden"}`.
This prevents sensitive-personal inputs from being embedded, summarized,
or indexed by the downstream LLM.

## Wire compatibility

Wire shapes match `@soa-harness/memory-mcp-sqlite@1.0.0-rc.0` byte-for-byte.
A Runner configured with `SOA_RUNNER_MEMORY_MCP_ENDPOINT` pointing at
either backend accepts traffic identically.
