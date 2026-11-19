import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { Commit, HumanIdentity } from "./types.js";

const SIGNATURE_FIELD = "org.aispec.commitSignature.v1";
const DOMAIN = "AISpec commit signature v1\n";

export interface SigningKeyPair {
  publicKey: string;
  encryptedPrivateKey: string;
}

export type CommitSignatureVerification =
  | { status: "unsigned" }
  | { status: "invalid"; reason: string }
  | { status: "valid"; identity: HumanIdentity; keyFingerprint: string };

export function generateSigningKeyPair(passphrase: string): SigningKeyPair {
  if (passphrase.length < 12) {
    throw new Error("The private-key passphrase must contain at least 12 characters.");
  }
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase,
    },
  });
  return { publicKey: keys.publicKey, encryptedPrivateKey: keys.privateKey };
}

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null) {
      throw new Error("Signed data must contain only JSON values.");
    }
    if (ancestors.has(item)) throw new Error("Signed data must not contain cycles.");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return `[${Array.from(item, encode).join(",")}]`;
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error("Signed data must contain only plain JSON objects.");
      }
      const object = item as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${encode(object[key])}`,
      ).join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return encode(value);
}

export function hashCanonicalObject(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payload(commit: Commit, identity: HumanIdentity, publicKey: string): Buffer {
  const metadata = { ...commit.metadata };
  delete metadata[SIGNATURE_FIELD];
  return Buffer.from(DOMAIN + canonicalJson({
    commit: { ...commit, metadata },
    identity,
    publicKey,
  }), "utf8");
}

export function signCommit(
  commit: Commit,
  identity: HumanIdentity,
  encryptedPrivateKey: string,
  passphrase: string,
): Commit {
  if (!identity.id.trim() || !identity.name.trim() || !identity.email.trim()) {
    throw new Error("Author id, name, and email are required for signing.");
  }
  if (commit.author !== identity.name) {
    throw new Error("The declared commit author must match the signing author's name.");
  }
  if (commit.metadata && SIGNATURE_FIELD in commit.metadata) {
    throw new Error("Commit metadata already contains a signature.");
  }
  if (!encryptedPrivateKey.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----")) {
    throw new Error("The signing key must be an encrypted PKCS#8 private key.");
  }
  const privateKey = createPrivateKey({ key: encryptedPrivateKey, format: "pem", passphrase });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("The signing key must be Ed25519.");
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const signature = sign(null, payload(commit, identity, publicKey), privateKey).toString("base64");
  return {
    ...commit,
    metadata: {
      ...commit.metadata,
      [SIGNATURE_FIELD]: { algorithm: "Ed25519", identity, publicKey, signature },
    },
  };
}

export function verifyCommitSignature(commit: Commit): CommitSignatureVerification {
  const envelope: unknown = commit.metadata?.[SIGNATURE_FIELD];
  if (envelope === undefined) return { status: "unsigned" };
  if (!isRecord(envelope) || envelope.algorithm !== "Ed25519" ||
      typeof envelope.publicKey !== "string" || typeof envelope.signature !== "string" ||
      !isRecord(envelope.identity) || typeof envelope.identity.id !== "string" ||
      typeof envelope.identity.name !== "string" || typeof envelope.identity.email !== "string" ||
      !envelope.identity.id.trim() || !envelope.identity.name.trim() || !envelope.identity.email.trim()) {
    return { status: "invalid", reason: "Malformed commit signature." };
  }
  const identity: HumanIdentity = {
    id: envelope.identity.id,
    name: envelope.identity.name,
    email: envelope.identity.email,
  };
  if (identity.name !== commit.author) {
    return { status: "invalid", reason: "The signed author does not match the commit author." };
  }
  try {
    const key = createPublicKey(envelope.publicKey);
    if (key.asymmetricKeyType !== "ed25519") {
      return { status: "invalid", reason: "The signature key is not Ed25519." };
    }
    const bytes = Buffer.from(envelope.signature, "base64");
    if (bytes.length !== 64 || bytes.toString("base64") !== envelope.signature ||
        !verify(null, payload(commit, identity, envelope.publicKey), key, bytes)) {
      return { status: "invalid", reason: "The commit signature does not match." };
    }
    const der = key.export({ type: "spki", format: "der" });
    const keyFingerprint = createHash("sha256").update(der).digest("hex");
    return { status: "valid", identity, keyFingerprint };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { status: "invalid", reason: `Could not verify the commit signature: ${detail}` };
  }
}
