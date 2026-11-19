import { lstat, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { EngineSpecError } from "./errors.js";
import { FileBinaryInput, type BinaryInput, type LocalContentStore } from "./cas.js";
import { canonicalJson } from "./format.js";
import type {
  Json,
  JsonObject,
  ResourceDescriptor,
  SnapshotEntry,
} from "./model.js";

export interface ResourceSelector {
  type: string;
  locator: JsonObject;
}

export interface AdapterContext {
  workspaceRoot: string;
  content: LocalContentStore;
}

export interface DiffChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export interface ResourceConflict {
  resourceId: string;
  kind: string;
  reason: string;
  base?: SnapshotEntry;
  ours?: SnapshotEntry;
  theirs?: SnapshotEntry;
}

export type AdapterMergeResult =
  | { status: "resolved"; entry: SnapshotEntry }
  | { status: "conflicts"; conflicts: ResourceConflict[] }
  | { status: "unsupported"; reason: string };

export interface AdapterRestoreResult {
  restored: string[];
  skipped: Array<{ resourceId: string; reason: string }>;
}

export interface RestoreTarget {
  locator: JsonObject;
}

export interface ResourceAdapter {
  readonly id: string;
  readonly version: string;
  readonly resourceTypes: readonly string[];
  capture(selectors: ResourceSelector[], context: AdapterContext): Promise<SnapshotEntry[]>;
  compare(
    before: SnapshotEntry | null,
    after: SnapshotEntry | null,
    context: AdapterContext,
  ): Promise<{ changes: DiffChange[]; unsupported: string[] }>;
  merge(
    base: SnapshotEntry | null,
    ours: SnapshotEntry | null,
    theirs: SnapshotEntry | null,
    context: AdapterContext,
  ): Promise<AdapterMergeResult>;
  restore(
    entries: SnapshotEntry[],
    target: RestoreTarget,
    context: AdapterContext,
  ): Promise<AdapterRestoreResult>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, ResourceAdapter>();

  register(adapter: ResourceAdapter): void {
    const key = adapter.id;
    if (this.adapters.has(key)) {
      throw new EngineSpecError("ADAPTER_DUPLICATE", `Adapter already registered: ${key}`);
    }
    this.adapters.set(key, adapter);
  }

  get(id: string): ResourceAdapter | undefined {
    return this.adapters.get(id);
  }

  find(type: string): ResourceAdapter | undefined {
    return [...this.adapters.values()].find((adapter) => adapter.resourceTypes.includes(type));
  }
}

export class StructuredAdapter implements ResourceAdapter {
  readonly id = "enginespec.structured";
  readonly version = "1.0.0";
  readonly resourceTypes = ["structured.json"] as const;

  async capture(
    selectors: ResourceSelector[],
    context: AdapterContext,
  ): Promise<SnapshotEntry[]> {
    const result: SnapshotEntry[] = [];
    for (const selector of selectors) {
      if (selector.type !== "structured.json") continue;
      const resourceId = requireText(selector.locator, "resourceId");
      const state = selector.locator.state;
      if (!isJsonObject(state)) {
        throw new EngineSpecError(
          "ADAPTER_INVALID_SELECTOR",
          "structured.json requires an object state",
        );
      }
      result.push({
        resource: resourceDescriptor(resourceId, selector, this, "portable"),
        state: "present",
        contentRefs: [],
        structuredState: structuredClone(state),
      });
    }
    return result;
  }

  async compare(
    before: SnapshotEntry | null,
    after: SnapshotEntry | null,
    _context: AdapterContext,
  ): Promise<{ changes: DiffChange[]; unsupported: string[] }> {
    return { changes: diffJson(before?.structuredState, after?.structuredState), unsupported: [] };
  }

  async merge(
    base: SnapshotEntry | null,
    ours: SnapshotEntry | null,
    theirs: SnapshotEntry | null,
    _context: AdapterContext,
  ): Promise<AdapterMergeResult> {
    return threeWayMerge(base, ours, theirs);
  }

  async restore(
    entries: SnapshotEntry[],
    target: RestoreTarget,
    _context: AdapterContext,
  ): Promise<AdapterRestoreResult> {
    const values = entries.map((entry) => entry.structuredState);
    if (target.locator.receive !== "memory") {
      return {
        restored: [],
        skipped: entries.map((entry) => ({
          resourceId: entry.resource.resourceId,
          reason: "Structured restore requires the memory receiver",
        })),
      };
    }
    if (values.some((value) => value === undefined)) {
      return {
        restored: [],
        skipped: entries.map((entry) => ({
          resourceId: entry.resource.resourceId,
          reason: "Snapshot entry has no structured state",
        })),
      };
    }
    return { restored: entries.map((entry) => entry.resource.resourceId), skipped: [] };
  }
}

export class FilesystemAdapter implements ResourceAdapter {
  readonly id = "enginespec.filesystem";
  readonly version = "1.0.0";
  readonly resourceTypes = ["filesystem.file", "filesystem.directory"] as const;

  async capture(
    selectors: ResourceSelector[],
    context: AdapterContext,
  ): Promise<SnapshotEntry[]> {
    const entries: SnapshotEntry[] = [];
    for (const selector of selectors) {
      if (!this.resourceTypes.includes(selector.type as never)) continue;
      const relative = normalizeRelativePath(requireText(selector.locator, "path"));
      if (isWorkspaceBinding(relative)) continue;
      const absolute = path.resolve(context.workspaceRoot, relative);
      assertInside(context.workspaceRoot, absolute);
      if (isTraceStorePath(absolute, context.content.root)) {
        throw new EngineSpecError(
          "ADAPTER_TRACE_STORE_SELECTED",
          "The Trace Store must not be captured as workspace data",
        );
      }
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new EngineSpecError("ADAPTER_SYMLINK_UNSUPPORTED", `Symlinks are not followed: ${relative}`);
      }
      if (selector.type === "filesystem.file") {
        if (!info.isFile()) {
          throw new EngineSpecError("ADAPTER_INVALID_SELECTOR", `Expected a file: ${relative}`);
        }
        entries.push(await this.captureFile(resourceIdFromPath(relative), relative, absolute, context.content));
      } else {
        if (!info.isDirectory()) {
          throw new EngineSpecError("ADAPTER_INVALID_SELECTOR", `Expected a directory: ${relative}`);
        }
        await this.captureDirectory(relative, absolute, context.content, entries);
      }
    }
    entries.sort((left, right) =>
      left.resource.resourceId.localeCompare(right.resource.resourceId));
    return entries;
  }

  async compare(
    before: SnapshotEntry | null,
    after: SnapshotEntry | null,
    _context: AdapterContext,
  ): Promise<{ changes: DiffChange[]; unsupported: string[] }> {
    const pathValue = after?.resource.locator.path ?? before?.resource.locator.path ?? "/";
    if (!before) {
      return { changes: [{ path: String(pathValue), kind: "added", after: after?.resource }], unsupported: [] };
    }
    if (!after) {
      return { changes: [{ path: String(pathValue), kind: "removed", before: before.resource }], unsupported: [] };
    }
    if (!sameValue(before.contentRefs, after.contentRefs)) {
      return {
        changes: [{
          path: String(pathValue),
          kind: "changed",
          before: before.contentRefs,
          after: after.contentRefs,
        }],
        unsupported: [],
      };
    }
    return { changes: [], unsupported: [] };
  }

  async merge(
    base: SnapshotEntry | null,
    ours: SnapshotEntry | null,
    theirs: SnapshotEntry | null,
    _context: AdapterContext,
  ): Promise<AdapterMergeResult> {
    return threeWayMerge(base, ours, theirs);
  }

  async restore(
    entries: SnapshotEntry[],
    target: RestoreTarget,
    context: AdapterContext,
  ): Promise<AdapterRestoreResult> {
    const destinationRoot = requireText(target.locator, "path");
    const restored: string[] = [];
    const skipped: AdapterRestoreResult["skipped"] = [];
    for (const entry of entries) {
      if (entry.state === "deleted") {
        const relative = requireText(entry.resource.locator, "path");
        await rm(path.resolve(destinationRoot, relative), { recursive: true, force: true });
        restored.push(entry.resource.resourceId);
        continue;
      }
      const relative = requireText(entry.resource.locator, "path");
      const destination = path.resolve(destinationRoot, relative);
      assertInside(destinationRoot, destination);
      await mkdir(path.dirname(destination), { recursive: true });
      if (entry.resource.type === "filesystem.directory") {
        await mkdir(destination, { recursive: true });
        restored.push(entry.resource.resourceId);
        continue;
      }
      const content = entry.contentRefs[0]?.address;
      if (!content) {
        skipped.push({ resourceId: entry.resource.resourceId, reason: "Missing file content" });
        continue;
      }
      const output = await open(destination, "w");
      try {
        await context.content.copyTo(content, {
          async write(chunk: Uint8Array): Promise<void> {
            await output.write(chunk);
          },
        });
      } catch (cause) {
        await output.close();
        await rm(destination, { force: true });
        throw cause;
      }
      await output.close();
      restored.push(entry.resource.resourceId);
    }
    return { restored, skipped };
  }

  private async captureDirectory(
    relativeRoot: string,
    absoluteRoot: string,
    content: LocalContentStore,
    entries: SnapshotEntry[],
  ): Promise<void> {
    entries.push({
      resource: {
        resourceId: resourceIdFromPath(relativeRoot),
        type: "filesystem.directory",
        adapterId: this.id,
        adapterVersion: this.version,
        locator: { path: relativeRoot },
        restoreClass: "portable",
      },
      state: "present",
      contentRefs: [],
      structuredState: { empty: (await readdir(absoluteRoot)).length === 0 },
    });
    const names = (await readdir(absoluteRoot)).sort();
    for (const name of names) {
      const absolute = path.join(absoluteRoot, name);
      const relative = normalizeRelativePath(path.posix.join(relativeRoot.replaceAll("\\", "/"), name));
      if (isWorkspaceBinding(relative)) continue;
      if (isTraceStorePath(absolute, content.root)) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await this.captureDirectory(relative, absolute, content, entries);
      } else if (info.isFile()) {
        entries.push(await this.captureFile(resourceIdFromPath(relative), relative, absolute, content));
      }
    }
  }

  private async captureFile(
    resourceId: string,
    relative: string,
    absolute: string,
    content: LocalContentStore,
  ): Promise<SnapshotEntry> {
    const address = await content.put(new FileBinaryInput(absolute));
    const info = await stat(absolute);
    return {
      resource: {
        resourceId,
        type: "filesystem.file",
        adapterId: this.id,
        adapterVersion: this.version,
        locator: { path: relative },
        restoreClass: "portable",
      },
      state: "present",
      contentRefs: [{
        address,
        mediaType: "application/octet-stream",
      }],
      structuredState: { size: info.size },
    };
  }
}

function threeWayMerge(
  base: SnapshotEntry | null,
  ours: SnapshotEntry | null,
  theirs: SnapshotEntry | null,
): AdapterMergeResult {
  if (sameValue(ours, theirs)) {
    if (!ours && !theirs) {
      return { status: "unsupported", reason: "Resource is absent on both sides" };
    }
    return { status: "resolved", entry: structuredClone(ours ?? theirs!) };
  }
  if (sameValue(ours, base) && theirs) {
    return { status: "resolved", entry: structuredClone(theirs) };
  }
  if (sameValue(theirs, base) && ours) {
    return { status: "resolved", entry: structuredClone(ours) };
  }
  const resourceId = ours?.resource.resourceId ?? theirs?.resource.resourceId ?? base?.resource.resourceId;
  return {
    status: "conflicts",
    conflicts: [{
      resourceId: resourceId ?? "unknown",
      kind: "resource-changed",
      reason: "Both sides changed the resource independently",
      ...(base ? { base } : {}),
      ...(ours ? { ours } : {}),
      ...(theirs ? { theirs } : {}),
    }],
  };
}

function diffJson(before: Json | undefined, after: Json | undefined, current = ""): DiffChange[] {
  if (Object.is(before, after)) return [];
  const pathValue = current || "/";
  if (before === undefined) return [{ path: pathValue, kind: "added", after }];
  if (after === undefined) return [{ path: pathValue, kind: "removed", before }];
  if (!isJsonObject(before) || !isJsonObject(after)) {
    return [{ path: pathValue, kind: "changed", before, after }];
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) =>
    diffJson(before[key], after[key], `${current}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
  );
}

function resourceDescriptor(
  resourceId: string,
  selector: ResourceSelector,
  adapter: ResourceAdapter,
  restoreClass: ResourceDescriptor["restoreClass"],
): ResourceDescriptor {
  return {
    resourceId,
    type: selector.type,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    locator: structuredClone(selector.locator),
    restoreClass,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function requireText(value: JsonObject, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) {
    throw new EngineSpecError("ADAPTER_INVALID_SELECTOR", `${key} must be a non-empty string`);
  }
  return result;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new EngineSpecError("ADAPTER_INVALID_SELECTOR", "Resource path escapes workspace");
  }
  return normalized;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (path.resolve(root) !== path.resolve(candidate)) {
      throw new EngineSpecError("ADAPTER_INVALID_SELECTOR", "Resource path escapes target root");
    }
  }
}

function isWorkspaceBinding(relative: string): boolean {
  return relative === ".enginespec" || relative.startsWith(".enginespec/");
}

function isTraceStorePath(candidate: string, traceRoot: string): boolean {
  const relative = path.relative(path.resolve(traceRoot), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." &&
    !path.isAbsolute(relative));
}

function resourceIdFromPath(relative: string): string {
  return `filesystem:${relative}`;
}

