import { createHash } from "node:crypto";
import {
  constants,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EngineSpecError } from "./errors.js";
import type { ContentAddress } from "./model.js";

export interface BinaryInput {
  read(): Promise<Uint8Array | null>;
}

export interface BinaryOutput {
  write(chunk: Uint8Array): Promise<void>;
}

export interface FileContentStore {
  root: string;
  put(source: BinaryInput): Promise<ContentAddress>;
  copyTo(address: ContentAddress, target: BinaryOutput): Promise<void>;
  verify(address: ContentAddress): Promise<boolean>;
  exists(address: ContentAddress): Promise<boolean>;
}

export class LocalContentStore implements FileContentStore {
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.join(this.root, "cas", "sha256"), { recursive: true });
  }

  async put(source: BinaryInput): Promise<ContentAddress> {
    await this.initialize();
    const temporary = path.join(this.root, "cas", `${randomUUID()}.tmp`);
    const hash = createHash("sha256");
    let size = 0;
    const output = await open(temporary, "wx");
    try {
      while (true) {
        const chunk = await source.read();
        if (chunk === null) break;
        await output.write(chunk);
        hash.update(chunk);
        size += chunk.byteLength;
      }
      await output.sync();
    } finally {
      await output.close();
    }

    const digest = hash.digest("hex");
    const destination = this.addressPath(digest);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await link(temporary, destination);
    } catch (cause) {
      if (!isFileExists(cause)) throw new EngineSpecError(
        "CAS_WRITE_FAILED",
        `Could not publish CAS content ${digest}`,
        false,
        undefined,
        { cause },
      );
      if (!(await this.verify({ algorithm: "sha256", digest, size }))) {
        throw new EngineSpecError("CAS_DIGEST_MISMATCH", `Existing CAS content is corrupt: ${digest}`);
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return { algorithm: "sha256", digest, size };
  }

  async copyTo(address: ContentAddress, target: BinaryOutput): Promise<void> {
    if (!(await this.verify(address))) {
      throw new EngineSpecError(
        "CAS_DIGEST_MISMATCH",
        `CAS content is missing or corrupt: ${address.digest}`,
      );
    }
    const handle = await open(this.addressPath(address.digest), "r");
    try {
      const buffer = new Uint8Array(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        await target.write(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  async verify(address: ContentAddress): Promise<boolean> {
    if (address.algorithm !== "sha256") return false;
    const file = this.addressPath(address.digest);
    let fileStat;
    try {
      fileStat = await stat(file);
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw cause;
    }
    if (!fileStat.isFile() || fileStat.size !== address.size) return false;
    const bytes = await readFile(file);
    return createHash("sha256").update(bytes).digest("hex") === address.digest;
  }

  async exists(address: ContentAddress): Promise<boolean> {
    try {
      await stat(this.addressPath(address.digest));
      return true;
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw cause;
    }
  }

  async materialize(address: ContentAddress, destination: string): Promise<void> {
    if (!(await this.verify(address))) {
      throw new EngineSpecError("CAS_DIGEST_MISMATCH", `Cannot restore corrupt blob ${address.digest}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(this.addressPath(address.digest), destination, constants.COPYFILE_EXCL);
  }

  private addressPath(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new EngineSpecError("CAS_INVALID_ADDRESS", `Invalid SHA-256 digest: ${digest}`);
    }
    return path.join(this.root, "cas", "sha256", digest.slice(0, 2), digest.slice(2, 4), digest);
  }
}

export function bytesInput(bytes: Uint8Array): BinaryInput {
  let done = false;
  return {
    async read(): Promise<Uint8Array | null> {
      if (done) return null;
      done = true;
      return bytes;
    },
  };
}

export class FileBinaryInput implements BinaryInput {
  private offset = 0;

  constructor(private readonly filePath: string, private readonly chunkSize = 64 * 1024) {}

  async read(): Promise<Uint8Array | null> {
    if (this.offset === 0) await stat(this.filePath);
    const handle = await open(this.filePath, "r");
    try {
      const buffer = new Uint8Array(this.chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      if (bytesRead === 0) return null;
      this.offset += bytesRead;
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}

function isNotFound(cause: unknown): boolean {
  return isErrorCode(cause, "ENOENT");
}

function isFileExists(cause: unknown): boolean {
  return isErrorCode(cause, "EEXIST");
}

function isErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

