import { createHash, randomBytes } from "node:crypto";
import type { Capability } from "./types.js";

/** Minimal interface for the /permissions/resolve bearer gate. Expanded as §12 lands. */
export interface SessionStore {
  /** True if session_id has been registered. */
  exists(session_id: string): boolean;
  /** True if session_id exists AND the presented bearer hashes to the enrolled value. */
  validate(session_id: string, bearer: string): boolean;
  /** Full record lookup for resolvers that need the session's activeMode. */
  getRecord(session_id: string): SessionRecord | undefined;
  /** True when the bearer matches any registered session — used by /audit/tail. */
  anySession(bearer: string): boolean;
}

export interface SessionRecord {
  session_id: string;
  activeMode: Capability;
  user_sub: string;
  created_at: Date;
  expires_at: Date;
  /**
   * True when the bearer carries the `permissions:decide:<session_id>` scope
   * granted by T-03 `request_decide_scope:true` on POST /sessions. Required
   * by /permissions/decisions (§10.3.2). Default false.
   */
  canDecide: boolean;
}

export interface CreateSessionInput {
  activeMode: Capability;
  user_sub: string;
  ttlSeconds: number;
  now: Date;
  /** Optional explicit bearer (for tests). When omitted, the store mints a random one. */
  bearer?: string;
  /** Grant permissions:decide:<session_id> scope on the returned bearer. T-03. */
  canDecide?: boolean;
}

export interface CreatedSession {
  session_id: string;
  session_bearer: string;
  record: SessionRecord;
}

/**
 * In-memory session store for M1. Real §12 session lifecycle + persistence
 * to `/sessions/<id>.json` lands in M2. The store hashes bearers (sha256)
 * rather than retaining cleartext.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, { rec: SessionRecord; bearerHash: string }>();

  /** Legacy test helper — bearer + session_id known up front. Defaults to WorkspaceWrite. */
  register(
    session_id: string,
    bearer: string,
    opts?: {
      activeMode?: Capability;
      user_sub?: string;
      expires_at?: Date;
      created_at?: Date;
      canDecide?: boolean;
    }
  ): void {
    const created_at = opts?.created_at ?? new Date();
    const expires_at = opts?.expires_at ?? new Date(created_at.getTime() + 60 * 60 * 1000);
    const rec: SessionRecord = {
      session_id,
      activeMode: opts?.activeMode ?? "WorkspaceWrite",
      user_sub: opts?.user_sub ?? "test-user",
      created_at,
      expires_at,
      canDecide: opts?.canDecide ?? false
    };
    this.records.set(session_id, { rec, bearerHash: this.hash(bearer) });
  }

  /** Mint a new session + opaque bearer. Used by POST /sessions (§12.6). */
  create(input: CreateSessionInput): CreatedSession {
    const session_id = `ses_${randomBytes(12).toString("hex")}`; // 24 hex chars → matches ^ses_[A-Za-z0-9]{16,}$
    const session_bearer = input.bearer ?? randomBytes(32).toString("base64url");
    const rec: SessionRecord = {
      session_id,
      activeMode: input.activeMode,
      user_sub: input.user_sub,
      created_at: input.now,
      expires_at: new Date(input.now.getTime() + input.ttlSeconds * 1000),
      canDecide: input.canDecide ?? false
    };
    this.records.set(session_id, { rec, bearerHash: this.hash(session_bearer) });
    return { session_id, session_bearer, record: rec };
  }

  revoke(session_id: string): void {
    this.records.delete(session_id);
  }

  exists(session_id: string): boolean {
    return this.records.has(session_id);
  }

  validate(session_id: string, bearer: string): boolean {
    const entry = this.records.get(session_id);
    if (!entry) return false;
    return this.hash(bearer) === entry.bearerHash;
  }

  getRecord(session_id: string): SessionRecord | undefined {
    return this.records.get(session_id)?.rec;
  }

  anySession(bearer: string): boolean {
    const probe = this.hash(bearer);
    for (const entry of this.records.values()) {
      if (entry.bearerHash === probe) return true;
    }
    return false;
  }

  private hash(bearer: string): string {
    return createHash("sha256").update(bearer).digest("hex");
  }
}
