import canonicalize from "canonicalize";

export function jcs(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new Error("jcs: input has no canonical form (undefined or symbol at root)");
  }
  return serialized;
}

export function jcsBytes(value: unknown): Buffer {
  return Buffer.from(jcs(value), "utf8");
}
