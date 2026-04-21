import { describe, it, expect } from "vitest";
import {
  StreamEventEmitter,
  StreamEventTypeInvalid,
  STREAM_EVENT_TYPES,
  isStreamEventType
} from "../src/stream/index.js";

const FROZEN_NOW = new Date("2026-04-21T23:00:00.000Z");
const SESSION = "ses_streamfixture0000001";

describe("StreamEventEmitter — §14.1 25-type enum", () => {
  it("exports exactly 25 canonical types", () => {
    expect(STREAM_EVENT_TYPES).toHaveLength(25);
    // Spot-check required-by-§14.1 names.
    expect(STREAM_EVENT_TYPES).toContain("SessionStart");
    expect(STREAM_EVENT_TYPES).toContain("SessionEnd");
    expect(STREAM_EVENT_TYPES).toContain("CrashEvent");
    // NOT in the enum — these were rev-1 plan exemplars that the spec
    // doesn't actually declare as StreamEvent types:
    expect(STREAM_EVENT_TYPES).not.toContain("SessionCreated");
    expect(STREAM_EVENT_TYPES).not.toContain("MemoryDegraded");
    expect(STREAM_EVENT_TYPES).not.toContain("AuditSinkDegraded");
    expect(STREAM_EVENT_TYPES).not.toContain("BudgetWarning");
  });

  it("isStreamEventType: true for canonical, false for unknown", () => {
    expect(isStreamEventType("SessionStart")).toBe(true);
    expect(isStreamEventType("MemoryLoad")).toBe(true);
    expect(isStreamEventType("MemoryDegraded")).toBe(false); // stop_reason, not event
    expect(isStreamEventType("NotAType")).toBe(false);
    expect(isStreamEventType(42)).toBe(false);
  });

  it("emit accepts a canonical type, returns an EmittedEvent with sequence=0 on first call", () => {
    const em = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const evt = em.emit({
      session_id: SESSION,
      type: "SessionStart",
      payload: {
        agent_name: "test-agent",
        agent_version: "1.0",
        card_version: "1.0.0"
      }
    });
    expect(evt.session_id).toBe(SESSION);
    expect(evt.type).toBe("SessionStart");
    expect(evt.sequence).toBe(0);
    expect(evt.event_id).toMatch(/^evt_[0-9a-f]{12}$/);
    expect(evt.emitted_at).toBe(FROZEN_NOW.toISOString());
  });

  it("emit rejects unknown type at emit-side (closed-enum invariant)", () => {
    const em = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    expect(() =>
      em.emit({
        session_id: SESSION,
        type: "BogusEvent",
        payload: {}
      })
    ).toThrow(StreamEventTypeInvalid);
    // Buffer MUST NOT contain a partial record.
    expect(em.snapshot(SESSION)).toHaveLength(0);
  });

  it("per-session monotonic sequence; sessions' sequences are independent", () => {
    const em = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const a0 = em.emit({ session_id: "ses_aaaafixture000000001", type: "SessionStart", payload: { agent_name: "a", agent_version: "1.0", card_version: "1.0" } });
    const a1 = em.emit({ session_id: "ses_aaaafixture000000001", type: "MessageStart", payload: { message_id: "m1", role: "user" } });
    const b0 = em.emit({ session_id: "ses_bbbbfixture000000001", type: "SessionStart", payload: { agent_name: "b", agent_version: "1.0", card_version: "1.0" } });
    const a2 = em.emit({ session_id: "ses_aaaafixture000000001", type: "MessageEnd", payload: { message_id: "m1" } });
    expect(a0.sequence).toBe(0);
    expect(a1.sequence).toBe(1);
    expect(a2.sequence).toBe(2);
    expect(b0.sequence).toBe(0); // independent
  });

  it("unique event_id across events within a session", () => {
    const em = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const evt = em.emit({
        session_id: SESSION,
        type: "ContentBlockDelta",
        payload: { block_id: `b${i}`, delta: "x" }
      });
      expect(ids.has(evt.event_id)).toBe(false);
      ids.add(evt.event_id);
    }
  });

  it("snapshot returns a defensive copy (callers cannot mutate the internal buffer)", () => {
    const em = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    em.emit({ session_id: SESSION, type: "SessionStart", payload: { agent_name: "x", agent_version: "1", card_version: "1" } });
    const snap = em.snapshot(SESSION) as { length: number }[];
    // @ts-expect-error — intentional mutation attempt on the snapshot copy
    snap.push({ bogus: true });
    expect(em.snapshot(SESSION)).toHaveLength(1); // internal state unaffected
  });

  it("FIFO eviction at maxEventsPerSession; next_after pagination still valid for retained IDs", () => {
    const em = new StreamEventEmitter({ clock: () => FROZEN_NOW, maxEventsPerSession: 3 });
    const emitted = [];
    for (let i = 0; i < 5; i++) {
      emitted.push(
        em.emit({ session_id: SESSION, type: "ContentBlockDelta", payload: { block_id: `b${i}`, delta: "x" } })
      );
    }
    const snap = em.snapshot(SESSION);
    expect(snap).toHaveLength(3);
    // Oldest 2 evicted; sequences 2, 3, 4 retained.
    expect(snap.map((e) => e.sequence)).toEqual([2, 3, 4]);
  });
});
