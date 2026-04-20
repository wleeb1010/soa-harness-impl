import { describe, it, expect } from "vitest";
import { jcs, jcsBytes } from "../src/jcs.js";

describe("jcs — primitives", () => {
  it("canonicalizes null, booleans, integers, strings", () => {
    expect(jcs(null)).toBe("null");
    expect(jcs(true)).toBe("true");
    expect(jcs(false)).toBe("false");
    expect(jcs(0)).toBe("0");
    expect(jcs(42)).toBe("42");
    expect(jcs(-1)).toBe("-1");
    expect(jcs("hello")).toBe('"hello"');
    expect(jcs("")).toBe('""');
  });

  it("rejects NaN and Infinity (not representable in JSON)", () => {
    expect(() => jcs(Number.NaN)).toThrow();
    expect(() => jcs(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => jcs(Number.NEGATIVE_INFINITY)).toThrow();
  });

  it("rejects root undefined", () => {
    expect(() => jcs(undefined)).toThrow();
  });
});

describe("jcs — arrays", () => {
  it("preserves order and canonicalizes children", () => {
    expect(jcs([])).toBe("[]");
    expect(jcs([1, 2, 3])).toBe("[1,2,3]");
    expect(jcs([null, true, "x"])).toBe('[null,true,"x"]');
  });

  it("recurses into nested arrays", () => {
    expect(jcs([[1, 2], [3, [4]]])).toBe("[[1,2],[3,[4]]]");
  });
});

describe("jcs — objects", () => {
  it("sorts keys lexicographically (UCS-2 code-unit order)", () => {
    expect(jcs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(jcs({ z: 1, m: 2, a: 3 })).toBe('{"a":3,"m":2,"z":1}');
  });

  it("canonicalizes nested objects", () => {
    expect(jcs({ outer: { b: 1, a: 2 }, alpha: [3, 1] })).toBe(
      '{"alpha":[3,1],"outer":{"a":2,"b":1}}'
    );
  });

  it("handles empty objects", () => {
    expect(jcs({})).toBe("{}");
  });
});

describe("jcsBytes", () => {
  it("returns UTF-8 encoded bytes", () => {
    const bytes = jcsBytes({ a: 1 });
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString("utf8")).toBe('{"a":1}');
  });

  it("produces the same bytes jcs + UTF-8 encoding would", () => {
    const v = { b: 2, a: 1 };
    const viaBytes = jcsBytes(v);
    const viaString = Buffer.from(jcs(v), "utf8");
    expect(viaBytes.equals(viaString)).toBe(true);
  });
});
