/**
 * §10.6 + §10.6.2 L-48 Findings BD/BE/BF — handler key lifecycle
 * registry + env-hook test surface.
 *
 * The registry tracks every handler kid the Runner recognises,
 * together with {spki_hex, algo, enrolled_at, rotation_overlap_end?},
 * and exposes the two runtime gates:
 *
 *   - `HandlerKeyExpired`: enrollment age > 90 days → 403 at verify
 *     time with reason=key-age-exceeded + age_days.
 *   - `HandlerKeyRevoked`: kid appears in the revocation set → 403.
 *
 * The registry is deliberately decoupled from the PDA verify path —
 * decisions-route consults the age/revocation gates BEFORE verifying
 * so an expired-but-otherwise-valid signature never satisfies a
 * Prompt. §10.6.2 rotation-overlap test hook loads a second kid from
 * a pinned fixture dir so SV-PERM-10 can drive both-kids-verify
 * scenarios under a reference clock.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
  "::ffff:127.0.0.1"
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_DAYS = 90;

/** §10.6 closed algo set accepted for handler keys. */
export const HANDLER_ALGOS = ["EdDSA", "ES256", "RS3072", "RS4096"] as const;
export type HandlerAlgo = (typeof HANDLER_ALGOS)[number];
const HANDLER_ALGO_SET: ReadonlySet<string> = new Set<string>(HANDLER_ALGOS);

export function isHandlerAlgo(value: string): value is HandlerAlgo {
  return HANDLER_ALGO_SET.has(value);
}

export interface HandlerKeyEntry {
  kid: string;
  spki_hex: string;
  algo: HandlerAlgo;
  enrolled_at: string; // RFC 3339
  rotation_overlap_end?: string; // RFC 3339
}

export interface HandlerKeyExpiredInfo {
  age_days: number;
  enrolled_at: string;
  max_age_days: number;
}

export class HandlerKeyExpired extends Error {
  readonly kid: string;
  readonly info: HandlerKeyExpiredInfo;
  constructor(kid: string, info: HandlerKeyExpiredInfo) {
    super(
      `HandlerKeyExpired: kid="${kid}" age_days=${info.age_days} exceeds ` +
        `max ${info.max_age_days} (enrolled_at=${info.enrolled_at})`
    );
    this.name = "HandlerKeyExpired";
    this.kid = kid;
    this.info = info;
  }
}

export class HandlerKeyRevoked extends Error {
  readonly kid: string;
  readonly revoked_at: string;
  readonly reason: string;
  constructor(kid: string, revoked_at: string, reason: string) {
    super(`HandlerKeyRevoked: kid="${kid}" revoked_at=${revoked_at} reason=${reason}`);
    this.name = "HandlerKeyRevoked";
    this.kid = kid;
    this.revoked_at = revoked_at;
    this.reason = reason;
  }
}

export class HandlerKidConflict extends Error {
  readonly kid: string;
  constructor(kid: string) {
    super(`HandlerKidConflict: kid="${kid}" already enrolled`);
    this.name = "HandlerKidConflict";
    this.kid = kid;
  }
}

export class AlgorithmRejected extends Error {
  readonly attempted: string;
  constructor(attempted: string) {
    super(
      `AlgorithmRejected: algo="${attempted}" not in §10.6 accepted set ` +
        `{${HANDLER_ALGOS.join(", ")}}`
    );
    this.name = "AlgorithmRejected";
    this.attempted = attempted;
  }
}

/** §10.6 handler key registry + lifecycle gates. */
export class HandlerKeyRegistry {
  private readonly byKid = new Map<string, HandlerKeyEntry>();
  private readonly revoked = new Map<
    string,
    { revoked_at: string; reason: string }
  >();
  private lastCrlRefreshAt: string | null = null;
  private readonly maxAgeDays: number;

  constructor(opts?: { maxAgeDays?: number }) {
    this.maxAgeDays = opts?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  }

  enroll(entry: HandlerKeyEntry): void {
    if (!isHandlerAlgo(entry.algo)) {
      throw new AlgorithmRejected(entry.algo);
    }
    if (this.byKid.has(entry.kid)) throw new HandlerKidConflict(entry.kid);
    this.byKid.set(entry.kid, { ...entry });
  }

  /** True when kid is enrolled (ignores revocation + age). */
  has(kid: string): boolean {
    return this.byKid.has(kid);
  }

  get(kid: string): HandlerKeyEntry | undefined {
    const entry = this.byKid.get(kid);
    return entry ? { ...entry } : undefined;
  }

  kids(): readonly string[] {
    return [...this.byKid.keys()];
  }

  revoke(kid: string, revoked_at: string, reason: string): void {
    this.revoked.set(kid, { revoked_at, reason });
  }

  isRevoked(kid: string): boolean {
    return this.revoked.has(kid);
  }

  revocationInfo(kid: string): { revoked_at: string; reason: string } | null {
    const r = this.revoked.get(kid);
    return r ? { ...r } : null;
  }

  /** Stamp `crl-refresh-complete` observability metadata. */
  recordCrlRefresh(nowIso: string): void {
    this.lastCrlRefreshAt = nowIso;
  }

  getLastCrlRefreshAt(): string | null {
    return this.lastCrlRefreshAt;
  }

  /**
   * §10.6.2 — check a kid against age + revocation + overlap window.
   * Returns null when the kid is currently valid; throws one of the
   * typed errors otherwise. Age math: age_days = now − enrolled_at.
   * Overlap rule: if `rotation_overlap_end` is set and now ≤ that
   * value, the kid remains valid regardless of age math; past that
   * boundary the age check applies normally.
   */
  assertUsable(kid: string, now: Date): void {
    const entry = this.byKid.get(kid);
    if (entry === undefined) return; // unknown kid — verify path raises its own error
    const rev = this.revoked.get(kid);
    if (rev !== undefined) {
      throw new HandlerKeyRevoked(kid, rev.revoked_at, rev.reason);
    }
    // Overlap window — while inside, skip age check.
    if (entry.rotation_overlap_end !== undefined) {
      const overlapEnd = Date.parse(entry.rotation_overlap_end);
      if (Number.isFinite(overlapEnd) && now.getTime() <= overlapEnd) {
        return;
      }
    }
    const enrolledAt = Date.parse(entry.enrolled_at);
    if (!Number.isFinite(enrolledAt)) return; // malformed enrolled_at — let verify fail downstream
    const ageMs = now.getTime() - enrolledAt;
    const ageDays = Math.floor(ageMs / DAY_MS);
    if (ageDays > this.maxAgeDays) {
      throw new HandlerKeyExpired(kid, {
        age_days: ageDays,
        enrolled_at: entry.enrolled_at,
        max_age_days: this.maxAgeDays
      });
    }
  }
}

// --------------------------------------------------------------------------
// §10.6.2 env-hook production guards

export class HandlerEnvHookOnPublicListener extends Error {
  constructor(envName: string, host: string) {
    super(
      `HandlerEnvHookOnPublicListener: ${envName} is set and listener ` +
        `binds to non-loopback host "${host}". Per §10.6.2 handler key ` +
        `lifecycle test hooks MUST NOT be reachable by untrusted principals.`
    );
    this.name = "HandlerEnvHookOnPublicListener";
  }
}

export interface HandlerEnvConfig {
  enrolledAtOverride?: string; // SOA_HANDLER_ENROLLED_AT
  overlapDir?: string; // SOA_HANDLER_KEYPAIR_OVERLAP_DIR
  crlPollTickMs?: number; // RUNNER_HANDLER_CRL_POLL_TICK_MS
}

export function parseHandlerEnv(env: NodeJS.ProcessEnv): HandlerEnvConfig {
  const out: HandlerEnvConfig = {};
  const enrolled = env["SOA_HANDLER_ENROLLED_AT"];
  if (typeof enrolled === "string" && enrolled.trim().length > 0) {
    out.enrolledAtOverride = enrolled.trim();
  }
  const overlap = env["SOA_HANDLER_KEYPAIR_OVERLAP_DIR"];
  if (typeof overlap === "string" && overlap.trim().length > 0) {
    out.overlapDir = overlap.trim();
  }
  const tickRaw = env["RUNNER_HANDLER_CRL_POLL_TICK_MS"];
  if (typeof tickRaw === "string" && tickRaw.trim().length > 0) {
    const n = Number.parseInt(tickRaw.trim(), 10);
    if (Number.isFinite(n) && n > 0) out.crlPollTickMs = n;
  }
  return out;
}

export function assertHandlerEnvListenerSafe(params: {
  env: HandlerEnvConfig;
  host: string;
}): void {
  const anySet =
    params.env.enrolledAtOverride !== undefined ||
    params.env.overlapDir !== undefined ||
    params.env.crlPollTickMs !== undefined;
  if (!anySet) return;
  if (LOOPBACK_HOSTS.has(params.host.toLowerCase())) return;
  const active =
    params.env.enrolledAtOverride !== undefined
      ? "SOA_HANDLER_ENROLLED_AT"
      : params.env.overlapDir !== undefined
        ? "SOA_HANDLER_KEYPAIR_OVERLAP_DIR"
        : "RUNNER_HANDLER_CRL_POLL_TICK_MS";
  throw new HandlerEnvHookOnPublicListener(active, params.host);
}

// --------------------------------------------------------------------------
// Overlap-directory loader: test-vectors/handler-keypair-overlap/key-{N}/

export interface OverlapKeyManifest {
  kid: string;
  algo: HandlerAlgo;
  issued_at: string;
  rotation_overlap_end: string;
  /** Optional base64url DER SPKI. Fixtures may carry a separate public.pem instead. */
  spki?: string;
  /** Optional filename of a sibling PEM under the same key- directory. */
  public_pem?: string;
}

/**
 * Load every per-key manifest under `<overlapDir>/key-<N>/manifest.json`
 * and convert to HandlerKeyEntry values. Fixtures may place an
 * `spki` field directly in manifest.json OR a sibling `public.pem`.
 * Manifest parse errors abort the load (fail-startup per §10.6.2).
 */
export function loadOverlapKeypairs(overlapDir: string): HandlerKeyEntry[] {
  if (!existsSync(overlapDir)) {
    throw new Error(
      `loadOverlapKeypairs: SOA_HANDLER_KEYPAIR_OVERLAP_DIR="${overlapDir}" does not exist`
    );
  }
  const out: HandlerKeyEntry[] = [];
  const entries = readdirSync(overlapDir);
  for (const entry of entries) {
    if (!entry.startsWith("key-")) continue;
    const entryDir = join(overlapDir, entry);
    const entryStat = statSync(entryDir);
    if (!entryStat.isDirectory()) continue;
    const manifestPath = join(entryDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(
        `loadOverlapKeypairs: ${entry}/manifest.json missing (required per §10.6.2)`
      );
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as OverlapKeyManifest;
    if (!isHandlerAlgo(manifest.algo)) {
      throw new Error(
        `loadOverlapKeypairs: ${entry}/manifest.json has non-conforming algo="${manifest.algo}"`
      );
    }
    let spkiHex = manifest.spki !== undefined ? manifest.spki : "";
    if (spkiHex.length === 0 && manifest.public_pem !== undefined) {
      const pemPath = join(entryDir, manifest.public_pem);
      if (existsSync(pemPath)) {
        // Convert PEM SPKI to hex byte string by stripping headers +
        // base64-decoding. Runner PDA verify uses the manifest-native
        // base64url form; we preserve raw hex for registry lookups.
        const pem = readFileSync(pemPath, "utf8");
        const b64 = pem
          .replace(/-----BEGIN PUBLIC KEY-----/g, "")
          .replace(/-----END PUBLIC KEY-----/g, "")
          .replace(/\s/g, "");
        spkiHex = Buffer.from(b64, "base64").toString("hex");
      }
    }
    out.push({
      kid: manifest.kid,
      spki_hex: spkiHex,
      algo: manifest.algo,
      enrolled_at: manifest.issued_at,
      rotation_overlap_end: manifest.rotation_overlap_end
    });
  }
  return out;
}
