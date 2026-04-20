/**
 * Clock factory — L-01 testability hook per Core §10.6.1.
 *
 * Precedence:
 *   1. If `envClock` (value of RUNNER_TEST_CLOCK env var) is set, prod-signal
 *      checks gate adoption. If ANY prod signal is present, we refuse to start
 *      rather than silently freeze wall-clock drift detection in production.
 *   2. Otherwise, the factory returns `() => new Date()` (wall clock).
 *
 * Prod signals (any present → refuse):
 *   - NODE_ENV === "production"
 *   - Serving TLS (tls options supplied) on a non-loopback host
 *
 * The hook is not exposed via HTTP — `test-only HTTP endpoint` is explicitly
 * one of the allowed forms in the spec, but it carries production reachability
 * risk and we decline it per the threat-model note on the paragraph.
 */

export type Clock = () => Date;

export interface ClockFactoryInputs {
  /** Value of RUNNER_TEST_CLOCK environment variable, or undefined. */
  envClock?: string | undefined;
  /** Value of NODE_ENV, or undefined. */
  nodeEnv?: string | undefined;
  /** True when the Runner will bind TLS (certs supplied). */
  tlsEnabled?: boolean;
  /** The host the Runner will bind. Used to detect non-loopback TLS serving. */
  host?: string | undefined;
}

export class TestClockInProductionError extends Error {
  override readonly name = "TestClockInProductionError";
  constructor(message: string) {
    super(message);
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);
// Note: 0.0.0.0 binds on all interfaces, including non-loopback. We treat it as
// "not clearly loopback" — if TLS is enabled on 0.0.0.0, the guard fires.

function isClearlyLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  return LOOPBACK_HOSTS.has(host) && host !== "0.0.0.0";
}

export function createClock(inputs: ClockFactoryInputs): Clock {
  const envClock = inputs.envClock;
  if (envClock === undefined || envClock === "") {
    return () => new Date();
  }

  if (inputs.nodeEnv === "production") {
    throw new TestClockInProductionError(
      "RUNNER_TEST_CLOCK is set but NODE_ENV=production. The L-01 clock-injection hook " +
        "MUST NOT be reachable in production deployments (Core §10.6.1). Unset one or the other."
    );
  }
  if (inputs.tlsEnabled && !isClearlyLoopback(inputs.host)) {
    throw new TestClockInProductionError(
      `RUNNER_TEST_CLOCK is set but the Runner is binding TLS on "${inputs.host ?? "<unset>"}" ` +
        `which is not clearly loopback. The L-01 clock-injection hook MUST NOT be reachable on ` +
        `publicly bound TLS listeners (Core §10.6.1).`
    );
  }

  const frozenAt = new Date(envClock);
  if (!Number.isFinite(frozenAt.getTime())) {
    throw new Error(
      `RUNNER_TEST_CLOCK=${JSON.stringify(envClock)} is not a valid ISO 8601 date-time.`
    );
  }

  return () => frozenAt;
}
