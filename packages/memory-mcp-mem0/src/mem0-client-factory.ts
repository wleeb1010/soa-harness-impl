/**
 * Factory that builds a production `Mem0LikeClient` from a mem0
 * `Memory` instance wired to the Qdrant + Ollama/OpenAI stack. Unit
 * tests bypass this and inject their own fake client.
 */

import type { Mem0LikeClient } from "./mem0-backend.js";

export interface CreateMem0ClientOptions {
  provider: "ollama" | "openai";
  ollamaUrl?: string;
  qdrantUrl?: string;
  collection: string;
  openaiApiKey?: string;
}

export async function createMem0Client(
  opts: CreateMem0ClientOptions
): Promise<Mem0LikeClient> {
  const { Memory } = (await import("mem0ai/oss")) as unknown as {
    Memory: new (config: Record<string, unknown>) => Mem0LikeClient;
  };

  const llm =
    opts.provider === "ollama"
      ? {
          provider: "ollama",
          config: {
            model: "llama3.1",
            url: opts.ollamaUrl ?? "http://localhost:11434",
            temperature: 0
          }
        }
      : {
          provider: "openai",
          config: { model: "gpt-4o-mini", apiKey: opts.openaiApiKey }
        };

  const embedder =
    opts.provider === "ollama"
      ? {
          provider: "ollama",
          config: {
            model: "nomic-embed-text",
            url: opts.ollamaUrl ?? "http://localhost:11434",
            embeddingDims: 768
          }
        }
      : {
          provider: "openai",
          config: {
            model: "text-embedding-3-small",
            apiKey: opts.openaiApiKey,
            embeddingDims: 1536
          }
        };

  const qdrantHost = (() => {
    try {
      return new URL(opts.qdrantUrl ?? "http://localhost:6333").hostname;
    } catch {
      return "localhost";
    }
  })();
  const qdrantPort = (() => {
    try {
      return Number.parseInt(new URL(opts.qdrantUrl ?? "http://localhost:6333").port || "6333", 10);
    } catch {
      return 6333;
    }
  })();

  return new Memory({
    llm,
    embedder,
    vectorStore: {
      provider: "qdrant",
      config: {
        collectionName: opts.collection,
        embeddingModelDims: opts.provider === "ollama" ? 768 : 1536,
        host: qdrantHost,
        port: qdrantPort
      }
    },
    disableHistory: true
  });
}
