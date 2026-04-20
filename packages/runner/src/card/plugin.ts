import type { FastifyPluginAsync } from "fastify";
import { registry } from "@soa-harness/schemas";
import { signAgentCard, type CardSignOptions, type SignedCard } from "./signer.js";

export interface CardPluginOptions extends CardSignOptions {
  /** Optional override — defaults to `/.well-known/agent-card.json`. */
  jsonPath?: string;
  /** Optional override — defaults to `/.well-known/agent-card.json.jws`. */
  jwsPath?: string;
}

const DEFAULT_JSON_PATH = "/.well-known/agent-card.json";
const DEFAULT_JWS_PATH = "/.well-known/agent-card.jws";

export const cardPlugin: FastifyPluginAsync<CardPluginOptions> = async (app, opts) => {
  const validate = registry["agent-card"];
  if (!validate(opts.card)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`.trim())
      .join("; ");
    throw new Error(`cardPlugin: card fails agent-card.schema.json (${detail || "no detail"})`);
  }

  const signed: SignedCard = await signAgentCard(opts);
  const jsonPath = opts.jsonPath ?? DEFAULT_JSON_PATH;
  const jwsPath = opts.jwsPath ?? DEFAULT_JWS_PATH;

  app.get(jsonPath, async (request, reply) => {
    const ifNoneMatch = request.headers["if-none-match"];
    reply.header("Cache-Control", "max-age=300").header("ETag", signed.etag);
    if (ifNoneMatch === signed.etag) {
      return reply.code(304).send();
    }
    return reply.code(200).type("application/json; charset=utf-8").send(signed.canonicalBody);
  });

  app.get(jwsPath, async (request, reply) => {
    const ifNoneMatch = request.headers["if-none-match"];
    reply.header("Cache-Control", "max-age=300").header("ETag", signed.etag);
    if (ifNoneMatch === signed.etag) {
      return reply.code(304).send();
    }
    return reply.code(200).type("application/jose").send(signed.detachedJws);
  });
};
