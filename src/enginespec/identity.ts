import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { canonicalJson } from "./format.js";
import { EngineSpecError } from "./errors.js";
import type {
  Identity,
  ObjectId,
  SignatureEnvelope,
  SignaturePayload,
} from "./model.js";

export interface SigningKeyPair {
  publicKey: string;
  encryptedPrivateKey: string;
}

export interface SignatureProvider {
  readonly id: string;
  sign(
    identity: Identity,
    target: SignaturePayload["target"],
    digest: ObjectId,
  ): Promise<SignatureEnvelope>;
}

export function generateEngineSpecKeyPair(passphrase: string): SigningKeyPair {
  if (passphrase.length < 12) {
    throw new EngineSpecError(
      "IDENTITY_PASSPHRASE_TOO_SHORT",
      "The signing key passphrase must contain at least 12 characters",
    );
  }
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase,
    },
  });
  return { publicKey: pair.publicKey, encryptedPrivateKey: pair.privateKey };
}

export class LocalSignatureProvider implements SignatureProvider {
  constructor(
    readonly id: string,
    private readonly encryptedPrivateKey: string,
    private readonly passphrase: string,
  ) {}

  async sign(
    identity: Identity,
    target: SignaturePayload["target"],
    digest: ObjectId,
  ): Promise<SignatureEnvelope> {
    if (!this.encryptedPrivateKey.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----")) {
      throw new EngineSpecError(
        "IDENTITY_INVALID_PRIVATE_KEY",
        "The signing key must be an encrypted PKCS#8 private key",
      );
    }
    let key;
    try {
      key = createPrivateKey({
        key: this.encryptedPrivateKey,
        format: "pem",
        passphrase: this.passphrase,
      });
    } catch (cause) {
      throw new EngineSpecError(
        "IDENTITY_SIGNING_FAILED",
        "Could not unlock signing key",
        false,
        undefined,
        { cause },
      );
    }
    if (key.asymmetricKeyType !== "ed25519") {
      throw new EngineSpecError("IDENTITY_KEY_UNSUPPORTED", "Signing key must use Ed25519");
    }
    const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
    const scope = signatureScope(target.kind);
    const context = signatureContext(scope, digest, identity, publicKey);
    const signature = sign(null, Buffer.from(canonicalJson(context), "utf8"), key).toString("base64");
    return {
      formatVersion: "2.0",
      signatureVersion: "2.0",
      algorithm: "ed25519",
      keyId: keyId(publicKey),
      publicKey,
      identity,
      scope,
      payloadDigest: digest,
      signature,
      createdAt: new Date().toISOString(),
    };
  }
}

export function verifyEngineSpecSignature(
  envelope: SignatureEnvelope,
  target: SignaturePayload["target"],
  digest: ObjectId,
): "valid" | "invalid" | "unsupported" {
  if (
    envelope.formatVersion !== "2.0" ||
    envelope.signatureVersion !== "2.0" ||
    envelope.algorithm !== "ed25519" ||
    envelope.payloadDigest !== digest ||
    envelope.scope !== signatureScope(target.kind)
  ) {
    return "invalid";
  }
  try {
    if (envelope.keyId !== keyId(envelope.publicKey)) return "invalid";
    const key = createPublicKey(envelope.publicKey);
    if (key.asymmetricKeyType !== "ed25519") return "unsupported";
    const bytes = Buffer.from(envelope.signature, "base64");
    return bytes.length === 64 &&
      verify(
        null,
        Buffer.from(canonicalJson(
          signatureContext(envelope.scope, digest, envelope.identity, envelope.publicKey),
        ), "utf8"),
        key,
        bytes,
      )
      ? "valid"
      : "invalid";
  } catch {
    return "invalid";
  }
}

export function signatureScope(
  kind: SignaturePayload["target"]["kind"],
): SignatureEnvelope["scope"] {
  if (kind === "commit" || kind === "snapshot" || kind === "provenance" || kind === "membership") {
    return kind;
  }
  return "object";
}

function signatureContext(
  scope: SignatureEnvelope["scope"],
  digest: ObjectId,
  identity: Identity,
  publicKey: string,
): Record<string, unknown> {
  return {
    domain: "EngineSpec signature v2",
    formatVersion: "2.0",
    signatureVersion: "2.0",
    scope,
    payloadDigest: digest,
    identity,
    publicKey,
  };
}

function keyId(publicKey: string): string {
  const der = createPublicKey(publicKey).export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

