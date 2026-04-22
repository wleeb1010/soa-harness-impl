/**
 * §13.1 Token budget tracker.
 *
 * Pseudo-code from §13.1 lines 1793-1800:
 *
 *   W = tokenBudget.projectionWindow  # default 10
 *   recent = last W turns' actual_total_tokens
 *   if |recent| < 3:
 *       baseline = max(tokens_in_message_stack + 2048, 4096)
 *       projected_tokens = baseline
 *   else:
 *       projected_tokens = ceil(percentile(recent, 0.95) * 1.15)
 *
 * Enforcement (§13.2): refuse the call + emit StopReason::BudgetExhausted
 * when `tokens_used_so_far + projected_tokens > tokenBudget.maxTokensPerRun`.
 *
 * Cache accounting (§13.3): cached input tokens count at 10% unless the
 * provider advertises a different ratio via MCP tool metadata. The tracker
 * records prompt + completion cached counts so /budget/projection can
 * surface them.
 *
 * /budget/projection reads via `getProjection()` are NOT-A-SIDE-EFFECT:
 * no counters advance, no cancellation fires. Recording is a separate
 * `recordTurn()` call path (called by the Runner at real turn boundaries).
 */

export interface BudgetConfig {
  /** §13.1 projectionWindow. Default 10. */
  projectionWindow?: number;
  /** §13.1 max tokens per run. Default 200_000. */
  maxTokensPerRun?: number;
  /** Safety factor applied to the p95 projection. §13.1 pins this at 1.15. */
  safetyFactor?: 1.15;
}

export interface TurnRecord {
  /** Actual tokens consumed for this turn (input + output + any cached). */
  actual_total_tokens: number;
  /** Optional breakdown for cache-accounting visibility. */
  prompt_tokens_cached?: number;
  completion_tokens_cached?: number;
  /** When the turn completed. Defaults to the tracker's clock. */
  recorded_at?: Date;
}

export interface ProjectionSnapshot {
  projected_tokens_remaining: number;
  max_tokens_per_run: number;
  cumulative_tokens_consumed: number;
  p95_tokens_per_turn_over_window_w: number;
  safety_factor: 1.15;
  projection_headroom?: number;
  stop_reason_if_exhausted: "BudgetExhausted";
  cold_start_baseline_active: boolean;
  cache_accounting?: {
    prompt_tokens_cached: number;
    completion_tokens_cached: number;
  };
}

export interface SessionBudgetState {
  session_id: string;
  turns: TurnRecord[]; // ring-buffer semantics, bounded at projectionWindow
  cumulative_tokens_consumed: number;
  prompt_tokens_cached_total: number;
  completion_tokens_cached_total: number;
}

const DEFAULT_WINDOW = 10;
const DEFAULT_MAX_TOKENS_PER_RUN = 200_000;
const MIN_SAMPLES_FOR_P95 = 3;
const COLD_START_FLOOR = 4096;
const COLD_START_OVERHEAD = 2048;
const SAFETY_FACTOR = 1.15;

/**
 * Compute the 95th percentile of an array using the linear-interpolation
 * method common in reporting tooling. Pure function — cross-platform stable.
 */
export function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  // rank = p * (n - 1) using 0-based indexing; p=0.95
  const rank = 0.95 * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export class BudgetTracker {
  private readonly projectionWindow: number;
  private readonly maxTokensPerRun: number;
  private readonly states = new Map<string, SessionBudgetState>();

  constructor(opts: BudgetConfig = {}) {
    this.projectionWindow = opts.projectionWindow ?? DEFAULT_WINDOW;
    this.maxTokensPerRun = opts.maxTokensPerRun ?? DEFAULT_MAX_TOKENS_PER_RUN;
    const sf = opts.safetyFactor ?? SAFETY_FACTOR;
    if (sf !== SAFETY_FACTOR) {
      // §13.1 pins the safety factor at 1.15. Extending is a spec change.
      throw new Error(`BudgetTracker: safety_factor must be 1.15 (§13.1), got ${sf}`);
    }
  }

  /** Idempotent per-session initialization. Called at §12.6 session bootstrap. */
  initFor(session_id: string): SessionBudgetState {
    const existing = this.states.get(session_id);
    if (existing) return existing;
    const state: SessionBudgetState = {
      session_id,
      turns: [],
      cumulative_tokens_consumed: 0,
      prompt_tokens_cached_total: 0,
      completion_tokens_cached_total: 0
    };
    this.states.set(session_id, state);
    return state;
  }

  /** Record a real turn. Advances counters; ring-buffers to projectionWindow. */
  recordTurn(session_id: string, record: TurnRecord): void {
    const state = this.states.get(session_id) ?? this.initFor(session_id);
    state.turns.push(record);
    if (state.turns.length > this.projectionWindow) state.turns.shift();
    state.cumulative_tokens_consumed += record.actual_total_tokens;
    if (typeof record.prompt_tokens_cached === "number") {
      state.prompt_tokens_cached_total += record.prompt_tokens_cached;
    }
    if (typeof record.completion_tokens_cached === "number") {
      state.completion_tokens_cached_total += record.completion_tokens_cached;
    }
  }

  /** True when the session has state recorded. */
  has(session_id: string): boolean {
    return this.states.has(session_id);
  }

  /**
   * §13.1 projection snapshot. Pure read — NOT-A-SIDE-EFFECT.
   *
   * `tokensInMessageStack` is the caller-supplied token count for the
   * current message stack (used in the cold-start baseline). When omitted,
   * treated as 0 — the baseline collapses to the floor (4096).
   */
  getProjection(session_id: string, tokensInMessageStack = 0): ProjectionSnapshot | undefined {
    const state = this.states.get(session_id);
    if (!state) return undefined;

    const window = state.turns.slice(-this.projectionWindow);
    const recentTotals = window.map((t) => t.actual_total_tokens);
    const coldStart = recentTotals.length < MIN_SAMPLES_FOR_P95;

    let p95: number;
    let projectedPerTurn: number;
    if (coldStart) {
      const baseline = Math.max(tokensInMessageStack + COLD_START_OVERHEAD, COLD_START_FLOOR);
      p95 = baseline;
      projectedPerTurn = baseline;
    } else {
      p95 = percentile95(recentTotals);
      projectedPerTurn = Math.ceil(p95 * SAFETY_FACTOR);
    }

    const remaining = this.maxTokensPerRun - state.cumulative_tokens_consumed;
    const projected_tokens_remaining = remaining;
    const projection_headroom =
      projectedPerTurn > 0 ? Math.floor(remaining / projectedPerTurn) : 0;

    const snap: ProjectionSnapshot = {
      projected_tokens_remaining,
      max_tokens_per_run: this.maxTokensPerRun,
      cumulative_tokens_consumed: state.cumulative_tokens_consumed,
      p95_tokens_per_turn_over_window_w: coldStart ? p95 : Math.round(p95 * 1000) / 1000,
      safety_factor: SAFETY_FACTOR,
      projection_headroom,
      stop_reason_if_exhausted: "BudgetExhausted",
      cold_start_baseline_active: coldStart,
      cache_accounting: {
        prompt_tokens_cached: state.prompt_tokens_cached_total,
        completion_tokens_cached: state.completion_tokens_cached_total
      }
    };
    return snap;
  }

  /**
   * §13.2 enforcement gate. True when the next turn would exceed
   * maxTokensPerRun given the current p95 projection. Callers (the future
   * mid-stream enforcement path) consult this before API calls and emit
   * SessionEnd{stop_reason:BudgetExhausted} when it returns true.
   */
  wouldExhaust(session_id: string, tokensInMessageStack = 0): boolean {
    const snap = this.getProjection(session_id, tokensInMessageStack);
    if (!snap) return false;
    const nextTurnProjection = snap.cold_start_baseline_active
      ? snap.p95_tokens_per_turn_over_window_w
      : Math.ceil(snap.p95_tokens_per_turn_over_window_w * SAFETY_FACTOR);
    return snap.cumulative_tokens_consumed + nextTurnProjection > this.maxTokensPerRun;
  }

  /** Remove state (post-termination cleanup). */
  remove(session_id: string): void {
    this.states.delete(session_id);
  }
}
