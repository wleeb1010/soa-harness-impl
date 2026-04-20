import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { jcsBytes } from "./jcs.js";

export function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestJson(absPath: string): string {
  const parsed: unknown = JSON.parse(readFileSync(absPath, "utf8"));
  return sha256Hex(jcsBytes(parsed));
}

export function digestRawUtf8(absPath: string): string {
  return sha256Hex(readFileSync(absPath));
}
