/**
 * In-memory Mem0LikeClient used by unit tests. Implements enough of the
 * mem0 Memory surface to exercise the backend's 6-tool contract without
 * Qdrant + Ollama standing up. Not a perfect substitute (scoring is
 * naive), but enough for tombstone idempotency, created_at, and the
 * L-58 sensitive-personal filter to be exercised correctly.
 */

import { randomBytes } from "node:crypto";
import type { Mem0LikeClient, Mem0LikeItem } from "../src/mem0-backend.js";

interface StoredItem extends Mem0LikeItem {
  id: string;
  memory: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export function createFakeMem0Client(): Mem0LikeClient & { __size(): number } {
  const items = new Map<string, StoredItem>();

  const client: Mem0LikeClient & { __size(): number } = {
    async add(content, config) {
      const id = `uuid-${randomBytes(4).toString("hex")}`;
      items.set(id, {
        id,
        memory: content,
        metadata: config.metadata ?? {},
        createdAt: new Date().toISOString()
      });
      return { results: [{ id }] };
    },
    async search(query, config) {
      const q = query.toLowerCase();
      const scored = Array.from(items.values())
        .map((it) => ({
          ...it,
          score:
            q.length === 0
              ? 0
              : it.memory.toLowerCase().includes(q)
                ? 0.8
                : 0.1
        }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, config.limit ?? 10);
      return { results: scored };
    },
    async get(id) {
      return items.get(id) ?? null;
    },
    async getAll(config) {
      return { results: Array.from(items.values()).slice(0, config.limit ?? 1000) };
    },
    async delete(id) {
      items.delete(id);
      return {};
    },
    __size() {
      return items.size;
    }
  };
  return client;
}
