import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";

type CryptoKeyPair = webcrypto.CryptoKeyPair;

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0]);

export interface SelfSignedEd25519Options {
  keys: CryptoKeyPair;
  subject: string;
  notBefore?: Date;
  notAfter?: Date;
  serialNumber?: string;
}

/**
 * Produce a self-signed X.509 cert over an Ed25519 keypair and return its DER bytes
 * base64-encoded — the exact shape required for an RFC 7515 §4.1.6 `x5c` array entry.
 *
 * Intended for local demos / integration tests only. Production Agent Card signing
 * keys come from an operator-issued chain anchored in `security.trustAnchors` per
 * Core §6.1.1; a self-signed leaf is not chain-verifiable against any real anchor.
 */
export async function generateSelfSignedEd25519Cert(opts: SelfSignedEd25519Options): Promise<string> {
  const {
    keys,
    subject,
    notBefore = new Date(Date.now() - 60 * 60 * 1000),
    notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    serialNumber = "01"
  } = opts;

  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber,
    name: subject,
    notBefore,
    notAfter,
    signingAlgorithm: { name: "Ed25519" },
    keys
  });

  return Buffer.from(cert.rawData).toString("base64");
}

export async function generateEd25519KeyPair(): Promise<CryptoKeyPair> {
  const keys = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown;
  if (
    keys === null ||
    typeof keys !== "object" ||
    !("privateKey" in keys) ||
    !("publicKey" in keys)
  ) {
    throw new Error("generateEd25519KeyPair: webcrypto returned a single key rather than a pair");
  }
  return keys as CryptoKeyPair;
}
