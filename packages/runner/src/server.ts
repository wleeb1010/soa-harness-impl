import { fastify, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { InitialTrust } from "./bootstrap/index.js";
import { cardPlugin, type JwsAlg, type PrivateKeyLike } from "./card/index.js";
import { probesPlugin, type ReadinessProbe } from "./probes/index.js";

export interface BuildRunnerOptions {
  trust: InitialTrust;
  card: unknown;
  alg: JwsAlg;
  kid: string;
  privateKey: PrivateKeyLike;
  x5c: string[];
  /** Readiness aggregator. Default: alwaysReady. Real checks wire in per component as they land. */
  readiness?: ReadinessProbe;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildRunnerApp(opts: BuildRunnerOptions): Promise<FastifyInstance> {
  const app = fastify(opts.fastifyOptions ?? {});

  await app.register(cardPlugin, {
    card: opts.card,
    alg: opts.alg,
    kid: opts.kid,
    privateKey: opts.privateKey,
    x5c: opts.x5c
  });

  await app.register(probesPlugin, opts.readiness ? { readiness: opts.readiness } : {});

  return app;
}

export interface StartRunnerOptions extends BuildRunnerOptions {
  host?: string;
  port?: number;
  tls?: {
    key: Buffer | string;
    cert: Buffer | string;
  };
}

export async function startRunner(opts: StartRunnerOptions): Promise<FastifyInstance> {
  const fastifyOptions: FastifyServerOptions = opts.fastifyOptions ?? {};
  if (opts.tls) {
    (fastifyOptions as FastifyServerOptions & { https: unknown }).https = {
      key: opts.tls.key,
      cert: opts.tls.cert,
      minVersion: "TLSv1.3"
    };
  }
  const app = await buildRunnerApp({ ...opts, fastifyOptions });
  await app.listen({ host: opts.host ?? "0.0.0.0", port: opts.port ?? 7700 });
  return app;
}
