/**
 * §10.5.5 L-48 Finding BC — RUNNER_AUDIT_SINK_MODE env hook production guard.
 *
 * Same loopback-only shape as §5.3.3 / §8.4.1 / §11.2.1 / §12.5.2 test
 * hooks: the env var MUST NOT be reachable by untrusted principals, so
 * the Runner refuses startup when set on a non-loopback listener.
 */

import type { AuditSinkMode } from "./chain.js";

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
  "::ffff:127.0.0.1"
]);

export class AuditSinkModeOnPublicListener extends Error {
  constructor(host: string) {
    super(
      `AuditSinkModeOnPublicListener: RUNNER_AUDIT_SINK_MODE is set and ` +
        `listener binds to non-loopback host "${host}". Per §10.5.5 the ` +
        `WORM-sink test hook MUST NOT be reachable by untrusted principals.`
    );
    this.name = "AuditSinkModeOnPublicListener";
  }
}

/**
 * Parse the env var to a canonical AuditSinkMode. Unknown values return
 * null (production default, no WORM model). The only accepted value in
 * L-48 is `worm-in-memory`.
 */
export function parseAuditSinkModeEnv(value: string | undefined): AuditSinkMode | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "worm-in-memory") return "worm-in-memory";
  return null;
}

export function assertAuditSinkModeListenerSafe(params: {
  mode: AuditSinkMode | null;
  host: string;
}): void {
  if (params.mode === null) return;
  if (LOOPBACK_HOSTS.has(params.host.toLowerCase())) return;
  throw new AuditSinkModeOnPublicListener(params.host);
}
