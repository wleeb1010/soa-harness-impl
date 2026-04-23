/**
 * Pluggable scoring providers for search_memories' composite_score.
 *
 * - `NaiveScorer` (default): substring token-overlap + recency +
 *   graph_strength. Deterministic, zero cold-start. Matches
 *   `memory-mcp-mock`'s scoring formula so SV-MEM-01..08 pass without
 *   a model file and without adding to the tarball.
 *
 * - `TransformersScorer` (opt-in): lazy-loads `@huggingface/transformers`
 *   at first use, runs MiniLM-L6-v2 cosine similarity against the note
 *   corpus, combines with recency + graph_strength. Gated on
 *   `SOA_MEMORY_MCP_SQLITE_SCORER=transformers`; the transformers
 *   dep is an optionalDependency so install stays lean by default.
 */

export interface ScorableNote {
  note_id: string;
  summary: string;
  recency_days_ago: number;
  graph_strength: number;
}

export interface ScoredHit {
  note_id: string;
  weight_semantic: number;
  weight_recency: number;
  weight_graph_strength: number;
  composite_score: number;
}

export interface Scorer {
  score(query: string, notes: ScorableNote[]): Promise<ScoredHit[]>;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export class NaiveScorer implements Scorer {
  async score(query: string, notes: ScorableNote[]): Promise<ScoredHit[]> {
    const q = query.toLowerCase();
    const tokens = q.split(/\s+/).filter((t) => t.length > 0);
    return notes.map((n) => {
      const haystack = n.summary.toLowerCase();
      const semantic =
        tokens.length === 0
          ? 0
          : tokens.filter((t) => haystack.includes(t)).length / tokens.length;
      const recency = 1 / (1 + n.recency_days_ago);
      const graph = n.graph_strength;
      const composite = 0.5 * semantic + 0.25 * recency + 0.25 * graph;
      return {
        note_id: n.note_id,
        weight_semantic: round3(semantic),
        weight_recency: round3(recency),
        weight_graph_strength: round3(graph),
        composite_score: round3(composite)
      };
    });
  }
}

export class TransformersScorer implements Scorer {
  private pipelinePromise: Promise<unknown> | null = null;

  private async pipeline(): Promise<unknown> {
    if (this.pipelinePromise) return this.pipelinePromise;
    this.pipelinePromise = (async () => {
      const mod = (await import("@huggingface/transformers")) as {
        pipeline: (task: string, model: string) => Promise<unknown>;
      };
      return mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    })();
    return this.pipelinePromise;
  }

  async score(query: string, notes: ScorableNote[]): Promise<ScoredHit[]> {
    const pipe = (await this.pipeline()) as (
      text: string | string[],
      opts: { pooling: "mean"; normalize: boolean }
    ) => Promise<{ data: Float32Array }>;

    const qVec = (await pipe(query, { pooling: "mean", normalize: true })).data;
    const out: ScoredHit[] = [];
    for (const n of notes) {
      const nVec = (await pipe(n.summary, { pooling: "mean", normalize: true })).data;
      let dot = 0;
      for (let i = 0; i < qVec.length; i++) dot += qVec[i]! * nVec[i]!;
      const semantic = Math.max(0, Math.min(1, dot));
      const recency = 1 / (1 + n.recency_days_ago);
      const graph = n.graph_strength;
      const composite = 0.5 * semantic + 0.25 * recency + 0.25 * graph;
      out.push({
        note_id: n.note_id,
        weight_semantic: round3(semantic),
        weight_recency: round3(recency),
        weight_graph_strength: round3(graph),
        composite_score: round3(composite)
      });
    }
    return out;
  }
}

export function scorerFromEnv(env: NodeJS.ProcessEnv): Scorer {
  const provider = (env["SOA_MEMORY_MCP_SQLITE_SCORER"] ?? "naive").toLowerCase();
  if (provider === "transformers") return new TransformersScorer();
  return new NaiveScorer();
}
