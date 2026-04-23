# `@soa-harness/memory-mcp-sqlite` — publish-ready container.
#
# Multi-stage build:
#   1. `builder`  — install deps, compile the native binding, build TS
#   2. `runtime`  — copy the prebuilt artifact and native binding into
#                   a slim node:20-alpine image; runs as the `node` user
#                   on localhost:8005 by default.
#
# Bind mount `/data` to a host volume for durable sqlite storage:
#   docker run -p 8005:8005 -v soa-memory:/data \
#     -e SOA_MEMORY_MCP_SQLITE_DB=/data/soa-memory.sqlite \
#     @soa-harness/memory-mcp-sqlite
#
# Loopback-only by default (HOST=127.0.0.1); set HOST=0.0.0.0 only if
# the container is behind an authenticated reverse proxy — this package
# carries fault-injection env hooks and MUST NOT be exposed to
# untrusted principals.

FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional
COPY src ./src
COPY tsconfig.json ./
COPY README.md LICENSE* ./
RUN npx tsc -b

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=8005 \
    SOA_MEMORY_MCP_SQLITE_DB=/data/soa-memory.sqlite \
    SOA_MEMORY_MCP_SQLITE_SCORER=naive
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8005
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" | grep -q '"alive"' || exit 1
CMD ["node", "dist/bin/start-sqlite.js"]
