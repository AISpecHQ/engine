import { createHash } from "node:crypto";
import { EngineSpecError } from "./errors.js";
import type { Json, JsonObject, ObjectEnvelope, ObjectId, ObjectRef, ObjectKind } from "./model.js";

const HEX_64 = /^[a-f0-9]{64}$/;

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new EngineSpecError("FORMAT_NOT_JSON_VALUE", "JSON numbers must be finite");
      }
      return JSON.stringify(item);
    }
    if (typeof item !== "object" || item === null) {
      throw new EngineSpecError("FORMAT_NOT_JSON_VALUE", "Value is not a JSON value");
    }
    if (ancestors.has(item)) {
      throw new EngineSpecError("FORMAT_NOT_JSON_VALUE", "JSON values cannot contain cycles");
    }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null &&
        !Array.isArray(item)) {
      throw new EngineSpecError("FORMAT_NOT_JSON_VALUE", "JSON values must use plain objects");
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort(compareUtf16).map((key) =>
        `${JSON.stringify(key)}:${encode(record[key])}`,
      ).join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return encode(value);
}

export function encodeEnvelope<T extends object>(
  kind: ObjectKind,
  payload: T,
): { envelope: ObjectEnvelope<T>; bytes: Uint8Array; id: ObjectId } {
  const envelope: ObjectEnvelope<T> = {
    format: "enginespec",
    formatVersion: "2.0",
    kind,
    payload,
  };
  const bytes = new TextEncoder().encode(canonicalJson(envelope));
  return { envelope, bytes, id: digestBytes(bytes) };
}

export function digestBytes(bytes: Uint8Array): ObjectId {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function digestJson(value: unknown): ObjectId {
  return digestBytes(new TextEncoder().encode(canonicalJson(value)));
}

export function parseObjectId(value: string, code = "FORMAT_INVALID_ID"): ObjectId {
  if (!value.startsWith("sha256:") || !HEX_64.test(value.slice(7))) {
    throw new EngineSpecError(code, `Invalid EngineSpec object ID: ${value}`);
  }
  return value as ObjectId;
}

export function decodeEnvelope(bytes: Uint8Array): {
  envelope: ObjectEnvelope<JsonObject>;
  id: ObjectId;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new EngineSpecError("FORMAT_INVALID_JSON", "Object is not valid UTF-8 JSON", false, undefined, {
      cause,
    });
  }
  if (!isEnvelope(parsed)) {
    throw new EngineSpecError("FORMAT_INVALID_ENVELOPE", "Invalid EngineSpec object envelope");
  }
  if (parsed.formatVersion !== "2.0") {
    throw new EngineSpecError(
      "FORMAT_VERSION_UNSUPPORTED",
      `Unsupported format version: ${String(parsed.formatVersion)}`,
    );
  }
  return { envelope: parsed, id: digestBytes(bytes) };
}

export function toJson(value: object): Json {
  return JSON.parse(canonicalJson(value)) as Json;
}

export function reference(kind: ObjectKind, id: ObjectId): ObjectRef {
  parseObjectId(id);
  return { kind, id };
}

function isEnvelope(value: unknown): value is ObjectEnvelope<JsonObject> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.format === "enginespec" &&
    typeof record.formatVersion === "string" &&
    typeof record.kind === "string" &&
    typeof record.payload === "object" &&
    record.payload !== null &&
    !Array.isArray(record.payload);
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

