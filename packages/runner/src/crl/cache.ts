import { registry } from "@soa-harness/schemas";
import type { Crl, CrlCheckOutcome, CrlFetcher, CrlFreshness } from "./types.js";

export interface CrlCacheOptions {
  fetcher: CrlFetcher;
  /** Refresh interval in milliseconds (default: 1 hour per Core §10.6). */
  refreshIntervalMs?: number;
  /** Hard staleness ceiling in milliseconds (default: 2 hours per UI §7.3.1). */
  staleCeilingMs?: number;
  /** Clock override (for tests). */
  now?: () => Date;
}

interface CrlEntry {
  crl: Crl;
  fetchedAt: Date;
  revokedKidSet: Map<string, Crl["revoked_kids"][number]>;
}

const DEFAULT_REFRESH_MS = 60 * 60 * 1000;
const DEFAULT_STALE_CEILING_MS = 2 * 60 * 60 * 1000;

export class CrlCache {
  private readonly fetcher: CrlFetcher;
  private readonly refreshIntervalMs: number;
  private readonly staleCeilingMs: number;
  private readonly nowFn: () => Date;
  private readonly entries = new Map<string, CrlEntry>();

  constructor(opts: CrlCacheOptions) {
    this.fetcher = opts.fetcher;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.staleCeilingMs = opts.staleCeilingMs ?? DEFAULT_STALE_CEILING_MS;
    this.nowFn = opts.now ?? (() => new Date());
  }

  /**
   * Force-refresh the CRL for a given anchor URI. The caller controls concurrency;
   * this method does not debounce. Validates the fetched body against the pinned
   * crl.schema.json and throws on invalid shape.
   */
  async refresh(anchorUri: string): Promise<Crl> {
    const crl = await this.fetcher(anchorUri);
    const validate = registry["crl"];
    if (!validate(crl)) {
      const detail = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`.trim())
        .join("; ");
      throw new Error(`CrlCache: fetched CRL for ${anchorUri} fails crl.schema.json: ${detail}`);
    }
    const revokedKidSet = new Map<string, Crl["revoked_kids"][number]>();
    for (const entry of crl.revoked_kids) {
      revokedKidSet.set(entry.kid, entry);
    }
    this.entries.set(anchorUri, { crl, fetchedAt: this.nowFn(), revokedKidSet });
    return crl;
  }

  /**
   * Inspect a kid against the cached CRL for the given anchor.
   *
   * Order of evaluation:
   *   1. no cache entry                 → expired, crl-missing
   *   2. past CRL not_after              → expired, crl-expired
   *   3. age > staleCeiling              → expired, crl-unreachable
   *   4. kid in revoked_kids             → revoked:true (freshness per age tier)
   *   5. fresh window                    → freshness:fresh
   *   6. else                            → freshness:stale-but-valid
   */
  check(anchorUri: string, kid: string): CrlCheckOutcome {
    const entry = this.entries.get(anchorUri);
    if (!entry) {
      return { freshness: "expired", revoked: false, failureReason: "crl-missing" };
    }

    const now = this.nowFn();
    const notAfter = new Date(entry.crl.not_after);
    if (Number.isFinite(notAfter.getTime()) && now >= notAfter) {
      return {
        freshness: "expired",
        revoked: false,
        failureReason: "crl-expired"
      };
    }

    const ageMs = now.getTime() - entry.fetchedAt.getTime();
    if (ageMs > this.staleCeilingMs) {
      return {
        freshness: "expired",
        revoked: false,
        failureReason: "crl-unreachable"
      };
    }

    const freshness: CrlFreshness = ageMs <= this.refreshIntervalMs ? "fresh" : "stale-but-valid";
    const revokedEntry = entry.revokedKidSet.get(kid);
    if (revokedEntry) {
      return { freshness, revoked: true, revokedEntry };
    }
    return { freshness, revoked: false };
  }

  /** Test helper: has a CRL been fetched for this anchor? */
  hasEntry(anchorUri: string): boolean {
    return this.entries.has(anchorUri);
  }

  /** Test helper: clear a specific anchor's cache. */
  evict(anchorUri: string): void {
    this.entries.delete(anchorUri);
  }
}
