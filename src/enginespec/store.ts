import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EngineSpecError } from "./errors.js";
import { decodeEnvelope, digestBytes, encodeEnvelope, parseObjectId } from "./format.js";
import type {
  ExpectedRef,
  Issue,
  ObjectEnvelope,
  ObjectId,
  ObjectKind,
  ObjectRef,
  Ref,
} from "./model.js";

interface TransactionRecord {
  id: string;
  state: "preparing" | "ready" | "committing" | "committed" | "recoverable";
  expectedRef: ExpectedRef | null;
  target: ObjectId | null;
  createdAt: string;
  errorCode?: string;
}

export interface RecoveryReport {
  valid: boolean;
  issues: Issue[];
}

export class LocalTraceStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async initialize(projectId: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root);
    const unexpected = entries.filter((entry) => ![
      "manifest.json",
      "objects",
      "cas",
      "refs",
      "journal",
      "index",
      "locks",
    ].includes(entry));
    if (unexpected.length > 0) {
      throw new EngineSpecError("STORE_NOT_EMPTY", "Trace Store directory is not empty");
    }
    await Promise.all([
      mkdir(path.join(this.root, "objects"), { recursive: true }),
      mkdir(path.join(this.root, "cas"), { recursive: true }),
      mkdir(path.join(this.root, "refs"), { recursive: true }),
      mkdir(path.join(this.root, "journal", "transactions"), { recursive: true }),
      mkdir(path.join(this.root, "index"), { recursive: true }),
      mkdir(path.join(this.root, "locks"), { recursive: true }),
    ]);
    const manifestPath = path.join(this.root, "manifest.json");
    try {
      await stat(manifestPath);
      throw new EngineSpecError("STORE_ALREADY_EXISTS", "Trace Store already exists");
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
    }
    await writeFile(manifestPath, `${JSON.stringify({
      format: "enginespec",
      formatVersion: "2.0",
      projectId,
      objectCodec: "jcs-rfc8785",
      digestAlgorithm: "sha256",
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }

  async open(): Promise<void> {
    const manifest = await this.readJson(path.join(this.root, "manifest.json"));
    if (manifest.format !== "enginespec" || manifest.formatVersion !== "2.0") {
      throw new EngineSpecError("STORE_UNSUPPORTED_FORMAT", "Unsupported Trace Store format");
    }
    await Promise.all([
      mkdir(path.join(this.root, "objects"), { recursive: true }),
      mkdir(path.join(this.root, "cas"), { recursive: true }),
      mkdir(path.join(this.root, "refs"), { recursive: true }),
      mkdir(path.join(this.root, "journal", "transactions"), { recursive: true }),
      mkdir(path.join(this.root, "index"), { recursive: true }),
      mkdir(path.join(this.root, "locks"), { recursive: true }),
    ]);
  }

  async put<T extends object>(kind: ObjectKind, payload: T): Promise<ObjectRef> {
    const encoded = encodeEnvelope(kind, payload);
    const reference = { kind, id: encoded.id } satisfies ObjectRef;
    const destination = this.objectPath(reference);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await this.writeExclusive(destination, encoded.bytes);
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
      const existing = await readFile(destination);
      if (digestBytes(existing) !== encoded.id) {
        throw new EngineSpecError("STORE_OBJECT_ID_CONFLICT", `Object ID collision: ${encoded.id}`);
      }
    }
    return reference;
  }

  async get(reference: ObjectRef): Promise<ObjectEnvelope> {
    const bytes = await readFile(this.objectPath(reference)).catch((cause) => {
      if (isNotFound(cause)) {
        throw new EngineSpecError("STORE_OBJECT_NOT_FOUND", `Object not found: ${reference.id}`, false, undefined, {
          cause,
        });
      }
      throw cause;
    });
    const decoded = decodeEnvelope(bytes);
    if (decoded.id !== reference.id || decoded.envelope.kind !== reference.kind) {
      throw new EngineSpecError("STORE_CORRUPT_OBJECT", `Object ${reference.id} does not match its path`);
    }
    return decoded.envelope;
  }

  async exists(reference: ObjectRef): Promise<boolean> {
    try {
      await stat(this.objectPath(reference));
      return true;
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw cause;
    }
  }

  async *list(kind?: ObjectKind): AsyncIterable<ObjectRef> {
    const base = path.join(this.root, "objects");
    const kinds = kind ? [kind] : [
      "project", "resource", "snapshot", "commit", "signature", "provenance", "membership",
    ] satisfies ObjectKind[];
    for (const objectKind of kinds) {
      const directory = path.join(base, objectKind);
      let files: Awaited<ReturnType<typeof readdirWithFiles>>;
      try {
        files = await readdirWithFiles(directory);
      } catch (cause) {
        if (isNotFound(cause)) continue;
        throw cause;
      }
      for (const file of files) {
        const id = `sha256:${path.basename(file, ".json")}` as ObjectId;
        parseObjectId(id);
        yield { kind: objectKind, id };
      }
    }
  }

  async getRef(name: Ref["name"]): Promise<Ref | null> {
    const file = this.refPath(name);
    try {
      const value = await this.readJson(file);
      return assertRef(value);
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw cause;
    }
  }

  async listRefs(prefix?: "heads/" | "tags/"): Promise<Ref[]> {
    const result: Ref[] = [];
    const scopes = prefix ? [prefix.slice(0, -1)] : ["heads", "tags"];
    for (const scope of scopes) {
      const directory = path.join(this.root, "refs", scope);
      let files: string[];
      try {
        files = await readdir(directory);
      } catch (cause) {
        if (isNotFound(cause)) continue;
        throw cause;
      }
      for (const file of files.filter((name) => name.endsWith(".json"))) {
        const encoded = file.slice(0, -5);
        const name = decodeURIComponent(encoded);
        result.push(assertRef(await this.readJson(path.join(directory, file)), `${scope}/${name}`));
      }
    }
    return result;
  }

  async beginTransaction(): Promise<string> {
    const id = randomUUID();
    await this.writeJson(this.transactionPath(id), {
      id,
      state: "preparing",
      expectedRef: null,
      target: null,
      createdAt: new Date().toISOString(),
    } satisfies TransactionRecord);
    return id;
  }

  async markReady(id: string, expectedRef: ExpectedRef, target: ObjectId): Promise<void> {
    const transaction = await this.readTransaction(id);
    transaction.state = "ready";
    transaction.expectedRef = expectedRef;
    transaction.target = target;
    await this.replaceJson(this.transactionPath(id), transaction);
  }

  async commitTransaction(id: string): Promise<Ref> {
    const transaction = await this.readTransaction(id);
    if (transaction.state !== "ready" || !transaction.expectedRef || !transaction.target) {
      throw new EngineSpecError("STORE_TRANSACTION_FAILED", `Transaction ${id} is not ready`);
    }
    transaction.state = "committing";
    await this.replaceJson(this.transactionPath(id), transaction);
    try {
      const ref = await this.compareAndSwapRef(transaction.expectedRef, transaction.target);
      transaction.state = "committed";
      await this.replaceJson(this.transactionPath(id), transaction);
      await rm(this.transactionPath(id), { force: true });
      return ref;
    } catch (cause) {
      transaction.state = "recoverable";
      transaction.errorCode = cause instanceof EngineSpecError ? cause.code : "UNKNOWN";
      await this.replaceJson(this.transactionPath(id), transaction);
      throw cause;
    }
  }

  async compareAndSwapRef(expected: ExpectedRef, target: ObjectId): Promise<Ref> {
    parseObjectId(target);
    const lock = await this.acquireLock(expected.name);
    try {
      const current = await this.getRef(expected.name);
      const observedTarget = current?.target ?? null;
      const observedGeneration = current?.generation ?? 0;
      if (observedTarget !== expected.target || observedGeneration !== expected.generation) {
        throw new EngineSpecError(
          "STORE_STALE_REF",
          `Ref changed: ${expected.name}`,
          true,
          { expected, observed: current },
        );
      }
      const next: Ref = {
        name: expected.name,
        target,
        generation: observedGeneration + 1,
      };
      await this.replaceJson(this.refPath(expected.name), next);
      return next;
    } finally {
      await lock.release();
    }
  }

  async recover(): Promise<RecoveryReport> {
    const issues: Issue[] = [];
    const directory = path.join(this.root, "journal", "transactions");
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (cause) {
      if (isNotFound(cause)) return { valid: true, issues: [] };
      throw cause;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const transaction = await this.readTransaction(path.basename(file, ".json"));
        if (transaction.state === "committing" || transaction.state === "ready") {
          await this.commitTransaction(transaction.id);
        } else if (transaction.state === "recoverable") {
          issues.push({
            severity: "warning",
            code: "STORE_RECOVERY_REQUIRED",
            message: `Transaction requires attention: ${transaction.id}`,
            object: transaction.id,
          });
        } else {
          await rm(this.transactionPath(transaction.id), { force: true });
        }
      } catch (cause) {
        issues.push({
          severity: "warning",
          code: cause instanceof EngineSpecError ? cause.code : "STORE_RECOVERY_FAILED",
          message: cause instanceof Error ? cause.message : String(cause),
          object: file,
        });
      }
    }
    return { valid: !issues.some((issue) => issue.severity === "error"), issues };
  }

  private async acquireLock(refName: string): Promise<{ release(): Promise<void> }> {
    const file = path.join(
      this.root,
      "locks",
      `${Buffer.from(refName).toString("hex")}.lock`,
    );
    const started = Date.now();
    while (true) {
      try {
        await writeFile(file, `${process.pid}\n`, { flag: "wx" });
        return { release: () => rm(file, { force: true }) };
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause;
        if (Date.now() - started > 5_000) {
          throw new EngineSpecError(
            "STORE_LOCK_TIMEOUT",
            `Timed out acquiring ref lock: ${refName}`,
            true,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private objectPath(reference: ObjectRef): string {
    const digest = reference.id.slice(7);
    return path.join(this.root, "objects", reference.kind, `${digest}.json`);
  }

  private refPath(name: Ref["name"]): string {
    const [scope, ...rest] = name.split("/");
    if (scope !== "heads" && scope !== "tags") {
      throw new EngineSpecError("STORE_INVALID_REF", `Invalid ref namespace: ${name}`);
    }
    const logical = rest.join("/");
    if (!logical || logical.includes("\0")) {
      throw new EngineSpecError("STORE_INVALID_REF", `Invalid ref name: ${name}`);
    }
    return path.join(this.root, "refs", scope, `${encodeURIComponent(logical)}.json`);
  }

  private transactionPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new EngineSpecError("STORE_INVALID_TRANSACTION", `Invalid transaction ID: ${id}`);
    }
    return path.join(this.root, "journal", "transactions", `${id}.json`);
  }

  private async readTransaction(id: string): Promise<TransactionRecord> {
    return await this.readJson(this.transactionPath(id)) as unknown as TransactionRecord;
  }

  private async readJson(file: string): Promise<Record<string, unknown>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (cause) {
      if (isNotFound(cause)) throw cause;
      throw new EngineSpecError("STORE_CORRUPT_OBJECT", `Invalid JSON in ${file}`, false, undefined, {
        cause,
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new EngineSpecError("STORE_CORRUPT_OBJECT", `Expected object in ${file}`);
    }
    return parsed as Record<string, unknown>;
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await this.writeExclusive(file, new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  }

  private async replaceJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithWindowsRetry(temporary, file);
  }

  private async writeExclusive(file: string, bytes: Uint8Array): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function readdirWithFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name));
}

function assertRef(value: Record<string, unknown>, expectedName?: string): Ref {
  if (typeof value.name !== "string" || typeof value.target !== "string" ||
      typeof value.generation !== "number") {
    throw new EngineSpecError("STORE_CORRUPT_OBJECT", "Invalid ref record");
  }
  const ref = {
    name: value.name as Ref["name"],
    target: parseObjectId(value.target),
    generation: value.generation,
  };
  if (expectedName && ref.name !== expectedName) {
    throw new EngineSpecError("STORE_CORRUPT_OBJECT", `Ref filename does not match ${expectedName}`);
  }
  return ref;
}

function isNotFound(cause: unknown): boolean {
  return isErrorCode(cause, "ENOENT");
}

function isAlreadyExists(cause: unknown): boolean {
  return isErrorCode(cause, "EEXIST");
}

function isErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

async function renameWithWindowsRetry(source: string, destination: string): Promise<void> {
  const delays = [10, 25, 50, 100, 200, 400, 800, 1_000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (cause) {
      const retryable = process.platform === "win32" &&
        (isErrorCode(cause, "EPERM") || isErrorCode(cause, "EACCES"));
      const delay = delays[attempt];
      if (!retryable || delay === undefined) throw cause;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

