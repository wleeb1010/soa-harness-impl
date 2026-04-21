/**
 * T-05 — SOA_RUNNER_BOOTSTRAP_BEARER public-listener guard.
 *
 * Per Core §12.6 the fixed-bootstrap-bearer surface (what `POST /sessions`
 * authenticates against when the env var is set) MUST NOT be reachable from
 * non-loopback interfaces. Full socket separation — a distinct listener
 * bound only to Unix-socket / named-pipe / localhost for the bootstrap
 * endpoint — is M2 scope. In M1 we ship the startup guard: refuse to boot
 * when the env var is set AND TLS is binding a non-loopback host.
 *
 * Permitted combinations:
 *   - env unset (any bind)                      — guard dormant
 *   - env set + no TLS                          — guard dormant (intra-host dev)
 *   - env set + TLS + loopback host             — guard dormant (dev-on-laptop)
 *   - env set + TLS + non-loopback host         — guard fires; startup aborts
 */

export class BootstrapBearerOnPublicListener extends Error {
  override readonly name = "BootstrapBearerOnPublicListener";
}

export interface BootstrapBearerGuardInputs {
  /** Value of SOA_RUNNER_BOOTSTRAP_BEARER env. Undefined / empty → no guard. */
  bearer?: string | undefined;
  /** True when Runner is binding TLS on the public listener. */
  tlsEnabled: boolean;
  /** Host string the Runner is binding to (e.g. "127.0.0.1", "0.0.0.0", a DNS name). */
  host?: string | undefined;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isClearlyLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  // 0.0.0.0 binds every interface including non-loopback; we treat it as
  // "not clearly loopback" on purpose — consistent with the L-01 test-clock guard.
  if (host === "0.0.0.0") return false;
  return LOOPBACK_HOSTS.has(host);
}

export function assertBootstrapBearerListenerSafe(inputs: BootstrapBearerGuardInputs): void {
  if (inputs.bearer === undefined || inputs.bearer === "") return;
  if (!inputs.tlsEnabled) return;
  if (isClearlyLoopback(inputs.host)) return;
  throw new BootstrapBearerOnPublicListener(
    `fixed-bootstrap-bearer-on-public-listener: SOA_RUNNER_BOOTSTRAP_BEARER is set AND the Runner is ` +
      `binding TLS on "${inputs.host ?? "<unset>"}" which is not a loopback host. §12.6 requires ` +
      `the fixed-bootstrap-bearer surface to be loopback-only. Move the bearer to a distinct ` +
      `loopback-only listener (M2), or remove the env var for public-TLS deployments and use an ` +
      `operator-tool bearer issuance surface outside the public endpoint.`
  );
}
