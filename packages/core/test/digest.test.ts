import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, digestJson, digestRawUtf8 } from "../src/digest.js";

// Canonical NIST/RFC test vectors for SHA-256.
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
  it("hashes well-known inputs", () => {
    expect(sha256Hex("")).toBe(SHA256_EMPTY);
    expect(sha256Hex("hello")).toBe(SHA256_HELLO);
    expect(sha256Hex("abc")).toBe(SHA256_ABC);
  });

  it("accepts Buffer and Uint8Array", () => {
    expect(sha256Hex(Buffer.from("hello"))).toBe(SHA256_HELLO);
    expect(sha256Hex(new Uint8Array(Buffer.from("hello")))).toBe(SHA256_HELLO);
  });
});

describe("digestJson / digestRawUtf8 (round-trip through tmp files)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "soa-digest-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("digestRawUtf8 hashes raw file bytes", () => {
    const p = join(dir, "raw.txt");
    writeFileSync(p, "hello");
    expect(digestRawUtf8(p)).toBe(SHA256_HELLO);
  });

  it("digestJson canonicalizes before hashing so key order is stable", () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, JSON.stringify({ a: 1, b: 2 }));
    writeFileSync(b, JSON.stringify({ b: 2, a: 1 }));
    expect(digestJson(a)).toBe(digestJson(b));
  });

  it("digestJson produces the JCS-canonical sha256 of a known input", () => {
    // Canonical form of { "a": 1, "b": [2, 3] } is '{"a":1,"b":[2,3]}' (17 bytes).
    const p = join(dir, "known.json");
    writeFileSync(p, JSON.stringify({ b: [2, 3], a: 1 }));
    // sha256 of UTF-8 bytes of '{"a":1,"b":[2,3]}'
    expect(digestJson(p)).toBe("efbd0040190fb0871831e606c581f8a66db79d8e2bb836745a70051306956070");
  });
});
