import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

const DATA_DIRECTORIES = [
  "nodes",
  "flows",
  "branches",
  "commits",
  "snapshots",
  "evaluations",
  "environments",
  "policies",
  "connectors",
  "artifacts",
  "extensions",
] as const;

export class RepositoryStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  static initialize(root: string): RepositoryStorage {
    mkdirSync(root, { recursive: true });
    const storage = new RepositoryStorage(root);
    for (const directory of DATA_DIRECTORIES) {
      mkdirSync(path.join(storage.root, directory), { recursive: true });
    }
    mkdirSync(path.join(storage.root, ".aispec"), { recursive: true });
    return storage;
  }

  static directories(): readonly string[] {
    return DATA_DIRECTORIES;
  }

  pathFor(directory: string, id: string): string {
    const filename = createHash("sha256").update(id).digest("hex");
    return path.join(directory, `${filename}.yaml`);
  }

  exists(relativePath: string): boolean {
    const absolute = this.resolve(relativePath);
    this.assertNoSymlink(absolute);
    return existsSync(absolute);
  }

  read<T>(relativePath: string): T {
    const absolute = this.resolve(relativePath);
    this.assertNoSymlink(absolute);
    const text = readFileSync(absolute, "utf8");
    const parsed: unknown = path.extname(absolute).toLowerCase() === ".json"
      ? JSON.parse(text)
      : parse(text);
    if (!isObject(parsed)) {
      throw new Error(`Expected a YAML/JSON object in ${relativePath}`);
    }
    return parsed as T;
  }

  write(relativePath: string, value: object, replace = false): void {
    const absolute = this.resolve(relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    this.assertNoSymlink(absolute);
    if (!replace && existsSync(absolute)) {
      throw new Error(`Refusing to overwrite immutable object: ${relativePath}`);
    }

    const temporary = `${absolute}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, stringify(value), { encoding: "utf8", flag: "wx" });
      this.assertNoSymlink(absolute);
      if (!replace && existsSync(absolute)) {
        throw new Error(`Refusing to overwrite immutable object: ${relativePath}`);
      }
      renameSync(temporary, absolute);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  list(directory: string): string[] {
    const absolute = this.resolve(directory);
    this.assertNoSymlink(absolute);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isSymbolicLink()) {
          throw new Error(`Symbolic links are not allowed: ${path.join(directory, entry.name)}`);
        }
        return entry.isFile() && /\.(?:yaml|yml|json)$/i.test(entry.name);
      })
      .map((entry) => path.join(directory, entry.name))
      .sort();
  }

  private resolve(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
      throw new Error("Expected a repository-relative path");
    }
    const absolute = path.resolve(this.root, relativePath);
    const relative = path.relative(this.root, absolute);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Path escapes AISpec repository root");
    }
    return absolute;
  }

  private assertNoSymlink(absolute: string): void {
    const relative = path.relative(this.root, absolute);
    let current = this.root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error(`Symbolic links are not allowed: ${segment}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
