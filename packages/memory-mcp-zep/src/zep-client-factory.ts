/**
 * Factory that builds a production `ZepLikeCollection` from a real
 * `@getzep/zep-js` client. Carries the Gate 4 SDK workarounds:
 *   - Uses `getDocuments([uuid])` under the hood for single-doc reads
 *     (SDK's `getDocument(uuid)` is broken against the server).
 *   - Ensures the alphanum collection exists; creates it if missing.
 */

import type { ZepDocument, ZepLikeCollection } from "./zep-backend.js";

export interface CreateZepCollectionOptions {
  zepUrl: string;
  collection: string;
  embeddingDimensions?: number;
}

export async function createZepCollection(
  opts: CreateZepCollectionOptions
): Promise<ZepLikeCollection> {
  const { ZepClient } = (await import("@getzep/zep-js")) as unknown as {
    ZepClient: { init: (url: string) => Promise<ZepClientLike> };
  };
  const zep = await ZepClient.init(opts.zepUrl);
  let coll: InternalCollection;
  try {
    coll = await zep.document.getCollection(opts.collection);
  } catch (err) {
    if (String(err).includes("NotFound") || /404/.test(String(err))) {
      await zep.document.addCollection({
        name: opts.collection,
        embeddingDimensions: opts.embeddingDimensions ?? 384,
        isAutoEmbedded: true,
        description: "SOA-Harness §8.1 note store"
      });
      coll = await zep.document.getCollection(opts.collection);
    } else {
      throw err;
    }
  }

  return {
    async addDocuments(docs: ZepDocument[]) {
      return coll.addDocuments(docs);
    },
    async getDocuments(uuids: string[]) {
      if (uuids.length === 0) return [];
      return coll.getDocuments(uuids);
    },
    async search(query, limit) {
      return coll.search(query, limit);
    },
    async deleteDocument(uuid: string) {
      await coll.deleteDocument(uuid);
    }
  };
}

interface ZepClientLike {
  document: {
    getCollection(name: string): Promise<InternalCollection>;
    addCollection(params: {
      name: string;
      embeddingDimensions: number;
      isAutoEmbedded: boolean;
      description?: string;
    }): Promise<unknown>;
  };
}

interface InternalCollection {
  addDocuments(docs: ZepDocument[]): Promise<string[]>;
  getDocuments(uuids: string[]): Promise<ZepDocument[]>;
  search(
    query: { text?: string; metadata?: Record<string, unknown> },
    limit?: number
  ): Promise<ZepDocument[]>;
  deleteDocument(uuid: string): Promise<void>;
}
