# `@soa-harness/memory-mcp-mem0` — publish-ready container.
#
# Multi-stage build:
#   1. `builder`  — install deps, build TS
#   2. `runtime`  — slim node:20-alpine, non-root, loopback default
#
# Run alongside a Qdrant container (see docker-compose.yml) and either
# a local Ollama (on the host or sidecar container) OR an OpenAI key
# via env (SOA_MEMORY_MCP_MEM0_PROVIDER=openai + OPENAI_API_KEY).
#
# The fault-injection env hooks MUST NOT be reachable by untrusted
# principals. HOST defaults to 127.0.0.1 for this reason.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional --omit=dev
COPY src ./src
COPY tsconfig.json ./
COPY README.md LICENSE* ./
RUN npm install --only=dev typescript@5 && npx tsc -b

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=8006 \
    SOA_MEMORY_MCP_MEM0_PROVIDER=ollama \
    OLLAMA_URL=http://host.docker.internal:11434 \
    QDRANT_URL=http://qdrant:6333 \
    SOA_MEMORY_MCP_MEM0_COLLECTION=soa_mem0_notes
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN chown -R node:node /app
USER node
EXPOSE 8006
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" | grep -q '"alive"' || exit 1
CMD ["node", "dist/bin/start-mem0.js"]
