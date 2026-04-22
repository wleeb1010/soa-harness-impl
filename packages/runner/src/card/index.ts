export { cardPlugin, type CardPluginOptions } from "./plugin.js";
export {
  signAgentCard,
  type CardSignOptions,
  type JwsAlg,
  type PrivateKeyLike,
  type SignedCard
} from "./signer.js";
export { generateSelfSignedEd25519Cert, generateEd25519KeyPair } from "./cert.js";
export {
  verifyAgentCardJws,
  CardSignatureFailed,
  type CardVerifyFailureReason,
  type TrustAnchor,
  type VerifyAgentCardOptions,
  type VerifiedCard
} from "./verify.js";
export {
  loadConformanceCard,
  ConformanceFixtureTampered,
  PLACEHOLDER_SPKI,
  PINNED_CONFORMANCE_CARD_DIGEST,
  type LoadConformanceCardOptions,
  type LoadedConformanceCard
} from "./conformance-loader.js";
export {
  loadAndVerifyExternalCardJws,
  type LoadExternalCardJwsOptions,
  type LoadedExternalJws
} from "./external-jws-loader.js";
export {
  checkCardPrecedence,
  type CardPrecedenceCheckInput,
  type CardPrecedenceCheckResult,
  type CardPrecedenceViolation,
  type CardPrecedenceSnapshot
} from "./precedence-guard.js";
