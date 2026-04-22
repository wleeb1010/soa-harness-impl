/**
 * §14.5.3 Process-global backpressure counters.
 *
 * GET /observability/backpressure returns a snapshot of the Runner's
 * OTel span / StreamEvent buffer under load. `buffer_capacity` is a
 * spec-pinned constant of 10000; everything else is monotonic or
 * nullable state updated by producer-side pressure events.
 *
 * Fields:
 *   buffer_capacity                  const 10000 (§14.5.3 normative)
 *   buffer_size_current              current occupancy
 *   dropped_since_boot               monotonic drop counter
 *   last_backpressure_applied_at     ISO-8601, null when never applied
 *   last_backpressure_dropped_count  drops in the most recent event
 *
 * In M3 there is no real pressure source — the Runner isn't yet
 * emitting enough spans / events to hit 10k. Cold-default state:
 *   { buffer_size_current:0, dropped_since_boot:0,
 *     last_backpressure_applied_at:null,
 *     last_backpressure_dropped_count:0 }
 *
 * Producers call `applied()` when they drop a batch due to full
 * buffer; `setBufferSize()` when the buffer occupancy changes. Both
 * are no-ops in M3 and exist for M4 wiring.
 */

export const BACKPRESSURE_BUFFER_CAPACITY = 10_000 as const;

export interface BackpressureSnapshot {
  buffer_capacity: typeof BACKPRESSURE_BUFFER_CAPACITY;
  buffer_size_current: number;
  dropped_since_boot: number;
  last_backpressure_applied_at: string | null;
  last_backpressure_dropped_count: number;
}

export interface BackpressureStateOptions {
  /** Clock for the last-applied timestamp. */
  clock: () => Date;
}

export class BackpressureState {
  private bufferSizeCurrent = 0;
  private droppedSinceBoot = 0;
  private lastAppliedAt: string | null = null;
  private lastDroppedCount = 0;
  private readonly clock: () => Date;

  constructor(opts: BackpressureStateOptions) {
    this.clock = opts.clock;
  }

  /** Record a backpressure event (producer dropped N records). */
  applied(droppedCount: number): void {
    if (droppedCount <= 0) return;
    this.droppedSinceBoot += droppedCount;
    this.lastDroppedCount = droppedCount;
    this.lastAppliedAt = this.clock().toISOString();
  }

  /** Update the running buffer occupancy. */
  setBufferSize(size: number): void {
    this.bufferSizeCurrent = Math.max(0, size);
  }

  /** Read-only snapshot. Reads DO NOT advance any counter. */
  snapshot(): BackpressureSnapshot {
    return {
      buffer_capacity: BACKPRESSURE_BUFFER_CAPACITY,
      buffer_size_current: this.bufferSizeCurrent,
      dropped_since_boot: this.droppedSinceBoot,
      last_backpressure_applied_at: this.lastAppliedAt,
      last_backpressure_dropped_count: this.lastDroppedCount
    };
  }
}
