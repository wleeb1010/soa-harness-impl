# Deploying `@soa-harness/memory-mcp-mem0`

mem0-backed Memory MCP. Semantic-first. Requires an LLM (OpenAI or
local Ollama) + a Qdrant vector store. Optionally a Neo4j graph store.

## Scaffold integration

```
npx create-soa-agent@next --memory=mem0 myagent
cd myagent
npm run memory:up     # brings up Qdrant + mem0 shim via docker-compose
npm install
npm start             # Runner on :7700, mem0 memory-mcp on :8006
```

The `memory:up` script runs `docker compose -f docker-compose.yml up -d`
using the compose file the scaffold ships.

## Service stack

- **Qdrant** (required): vector store; default `:6333`
- **mem0 shim** (`@soa-harness/memory-mcp-mem0`): §8.1 HTTP surface; default `:8006`
- **LLM provider** (one of):
  - **Ollama** (zero-egress, local): install locally, `ollama pull llama3.1`
    + `ollama pull nomic-embed-text`, expose `:11434` to the mem0
    container via `host.docker.internal`
  - **OpenAI**: set `OPENAI_API_KEY` + `SOA_MEMORY_MCP_MEM0_PROVIDER=openai`

Optional:
- **Neo4j** (graph-memory extension): uncomment the `neo4j` service in
  the compose file and set `NEO4J_AUTH=neo4j/<password>`.

## L-58 sensitive-personal filter

Requests with `data_class="sensitive-personal"` are rejected BEFORE any
bytes reach mem0's LLM call. Return shape:
`{error:"MemoryDeletionForbidden", reason:"sensitive-class-forbidden"}`.

## Fault injection

Same triad as sqlite, prefixed `SOA_MEMORY_MCP_MEM0_`. See the package
README.

## Package reference

Full env surface + endpoint table + docker-compose: see
[`packages/memory-mcp-mem0/README.md`](../../packages/memory-mcp-mem0/README.md).
