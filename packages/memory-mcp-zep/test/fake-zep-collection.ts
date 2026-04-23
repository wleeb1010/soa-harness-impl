/**
 * In-memory ZepLikeCollection used by unit tests. Implements enough of
 * Zep's Document Collection surface to exercise the backend's 6-tool
 * contract without standing up Zep + Postgres.
 */

import { randomBytes } from "node:crypto";
import type { ZepDocument, ZepLikeCollection } from "../src/zep-backend.js";

interface StoredDoc extends ZepDocument {
  uuid: string;
}

export function createFakeZepCollection(): ZepLikeCollection & { __size(): number } {
  const items = new Map<string, StoredDoc>();

  const coll: ZepLikeCollection & { __size(): number } = {
    async addDocuments(docs) {
      const uuids: string[] = [];
      for (const d of docs) {
        const uuid = `uuid-${randomBytes(4).toString("hex")}`;
        items.set(uuid, {
          uuid,
          content: d.content,
          document_id: d.document_id,
          metadata: d.metadata ?? {},
          created_at: new Date().toISOString()
        });
        uuids.push(uuid);
      }
      return uuids;
    },
    async getDocuments(uuids) {
      return uuids.map((u) => items.get(u)).filter((d): d is StoredDoc => !!d);
    },
    async search(query, limit) {
      const text = (query.text ?? "").toLowerCase();
      const scored = Array.from(items.values()).map((d) => ({
        ...d,
        score: text.length === 0 ? 0 : d.content.toLowerCase().includes(text) ? 0.8 : 0.1
      }));
      scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return scored.slice(0, limit ?? 10);
    },
    async deleteDocument(uuid) {
      items.delete(uuid);
    },
    __size() {
      return items.size;
    }
  };
  return coll;
}
