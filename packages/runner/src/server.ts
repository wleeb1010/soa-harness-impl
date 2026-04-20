import { fastify, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { InitialTrust } from "./bootstrap/index.js";
import { cardPlugin, type JwsAlg, type PrivateKeyLike } from "./card/index.js";

export interface BuildRunnerOptions {
  trust: InitialTrust;
  card: unknown;
  alg: JwsAlg;
  kid: string;
  privateKey: PrivateKeyLike;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildRunnerApp(opts: BuildRunnerOptions): Promise<FastifyInstance> {
  const app = fastify(opts.fastifyOptions ?? {});

  await app.register(cardPlugin, {
    card: opts.card,
    alg: opts.alg,
    kid: opts.kid,
    privateKey: opts.privateKey
  });

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
