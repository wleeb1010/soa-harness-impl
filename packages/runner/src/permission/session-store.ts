import { createHash } from "node:crypto";

/** Minimal interface for the /permissions/resolve bearer gate. Expanded as §12.3 lands. */
export interface SessionStore {
  /** True if session_id has been registered. */
  exists(session_id: string): boolean;
  /** True if session_id exists AND the presented bearer hashes to the enrolled value. */
  validate(session_id: string, bearer: string): boolean;
}

/**
 * In-memory session store for M1 — real session lifecycle lands with §12 in M2.
 * The store hashes the bearer so we never retain the cleartext token.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly byId = new Map<string, string>();

  register(session_id: string, bearer: string): void {
    this.byId.set(session_id, this.hash(bearer));
  }

  revoke(session_id: string): void {
    this.byId.delete(session_id);
  }

  exists(session_id: string): boolean {
    return this.byId.has(session_id);
  }

  validate(session_id: string, bearer: string): boolean {
    const expected = this.byId.get(session_id);
    if (!expected) return false;
    return this.hash(bearer) === expected;
  }

  private hash(bearer: string): string {
    return createHash("sha256").update(bearer).digest("hex");
  }
}
