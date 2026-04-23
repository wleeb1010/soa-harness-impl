# Deploying `@soa-harness/memory-mcp-zep`

Zep-backed Memory MCP. Uses Zep v0.27.2 (Apache-2.0) + Postgres +
bundled NLP server for local MiniLM embeddings. **No OpenAI key
required** — summarizer and entity extractors are disabled in the
shipped `config.yaml` so the Zep server boots on local embeddings
alone.

## Scaffold integration

```
npx create-soa-agent@next --memory=zep myagent
cd myagent
npm run memory:up     # brings up Zep + Postgres + NLP + zep shim
npm install
npm start             # Runner on :7700, zep memory-mcp on :8007
```

## Service stack

- **Postgres** (pgvector): `ghcr.io/getzep/postgres:latest`; default `:5433`
- **Zep NLP server** (local MiniLM-class embeddings, 384-dim): `:5557`
- **Zep** v0.27.2: `ghcr.io/getzep/zep:latest`; default `:8003`
- **zep shim** (`@soa-harness/memory-mcp-zep`): §8.1 HTTP surface; default `:8007`

Zep's image is sourced from GitHub Container Registry, **not Docker
Hub**. The scaffold's `docker-compose.yml` wires this automatically.

## SDK quirks (carried from Gate 4)

The shim works around two `@getzep/zep-js@0.10.0` issues:
- `getDocument(uuid)` builds a URL the current server 404s on. Shim
  uses `getDocuments([uuid])` instead.
- Collection names must be alphanum; underscores are rejected. The
  scaffold defaults to `soamemmcpzep`.

## L-58 sensitive-personal filter

Requests with `data_class="sensitive-personal"` are rejected BEFORE any
bytes reach Zep. Zep itself does not enforce this natively.

## Fault injection

Same triad, prefixed `SOA_MEMORY_MCP_ZEP_`.

## Package reference

Full env surface + endpoint table + docker-compose: see
[`packages/memory-mcp-zep/README.md`](../../packages/memory-mcp-zep/README.md).
