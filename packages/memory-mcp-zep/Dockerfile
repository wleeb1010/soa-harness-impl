# `@soa-harness/memory-mcp-zep` — publish-ready container.
#
# Run alongside the Zep + Postgres + NLP stack (docker-compose.yml).
# Loopback-only default — the fault-injection hooks MUST NOT be
# reachable by untrusted principals.

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
    PORT=8007 \
    ZEP_URL=http://zep:8000 \
    SOA_MEMORY_MCP_ZEP_COLLECTION=soamemmcpzep
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN chown -R node:node /app
USER node
EXPOSE 8007
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" | grep -q '"alive"' || exit 1
CMD ["node", "dist/bin/start-zep.js"]
