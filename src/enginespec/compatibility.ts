import { createHash } from "node:crypto";
import { cp, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AISpecEngine } from "../engine.js";
import type { Commit, Snapshot } from "../types.js";
import { EngineSpecEngine } from "./core.js";
import { EngineSpecError } from "./errors.js";
import type {
  CommitPayload,
  Identity,
  JsonObject,
  ObjectId,
  ObjectRef,
  ProvenancePayload,
  SnapshotEntry,
  SnapshotPayload,
  StoreLocator,
} from "./model.js";

export interface MigrateAISpecV0Input {
  source: string;
  workspace: string;
  traceStore: StoreLocator;
  dryRun?: boolean;
}

export interface AISpecV0MigrationResult {
  sourceFingerprint: string;
  projectId: string;
  commitMappings: Array<{ legacyId: string; v2Id: ObjectId }>;
  branchMappings: Array<{ legacyName: string; v2Ref: string; v2Id: ObjectId }>;
  copiedOriginals: boolean;
}

export async function migrateAISpecV0(
  input: MigrateAISpecV0Input,
): Promise<AISpecV0MigrationResult> {
  const source = path.resolve(input.source);
  const destinationTrace = path.resolve(input.traceStore.value);
  assertNonOverlapping(source, destinationTrace);
  const legacy = AISpecEngine.open(source);
  const commits = legacy.listCommits();
  const sourceFingerprint = await fingerprintDirectory(source);
  const projectId = legacy.manifest.id ?? legacyIdentityId(legacy.manifest.name ?? "project");
  const plan: AISpecV0MigrationResult = {
    sourceFingerprint,
    projectId,
    commitMappings: [],
    branchMappings: [],
    copiedOriginals: false,
  };
  if (input.dryRun) {
    validateLegacy(legacy.listNodes().map((node) => node.id), commits);
    return plan;
  }

  const engine = await EngineSpecEngine.initialize({
    name: legacy.manifest.name ?? "Migrated AISpec project",
    workspace: input.workspace,
    traceStore: input.traceStore,
    projectId,
  });
  const commitMappings = new Map<string, ObjectId>();
  const processing = new Set<string>();
  const migrateCommit = async (commit: Commit): Promise<ObjectRef> => {
    const mapped = commitMappings.get(commit.id);
    if (mapped) return { kind: "commit", id: mapped };
    if (processing.has(commit.id)) {
      throw new EngineSpecError("COMPATIBILITY_CYCLE", `Commit cycle at ${commit.id}`);
    }
    processing.add(commit.id);
    const parentRefs: ObjectRef[] = [];
    for (const parentId of commit.parents) {
      const parent = legacy.getCommit(parentId);
      if (!parent) {
        throw new EngineSpecError(
          "COMPATIBILITY_MISSING_PARENT",
          `Missing legacy parent: ${parentId}`,
        );
      }
      parentRefs.push(await migrateCommit(parent));
    }
    const state = legacy.getStateAtCommit(commit.id);
    const entries = [...state.values()]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map(snapshotEntry);
    const provenance = await engine.importMigratedObject<ProvenancePayload>("provenance", {
      actor: legacyIdentity(commit.author),
      action: "migrated",
      occurredAt: new Date().toISOString(),
      inputs: [],
      outputs: [],
      adapter: { id: "enginespec.compatibility.aispec-v0", version: "1" },
    });
    const snapshot = await engine.importMigratedObject<SnapshotPayload>("snapshot", {
      projectId,
      createdAt: commit.timestamp,
      entries,
      provenanceRefs: [provenance.id],
    });
    const mappedCommit = await engine.importMigratedObject<CommitPayload>("commit", {
      projectId,
      parents: parentRefs.map((reference) => reference.id),
      snapshotId: snapshot.id,
      author: legacyIdentity(commit.author),
      timestamp: commit.timestamp,
      message: commit.message,
      tags: [...(commit.tags ?? [])].sort(),
      provenanceRefs: [provenance.id],
    });
    commitMappings.set(commit.id, mappedCommit.id);
    plan.commitMappings.push({ legacyId: commit.id, v2Id: mappedCommit.id });
    processing.delete(commit.id);
    return mappedCommit;
  };
  for (const commit of commits) await migrateCommit(commit);

  for (const branch of legacy.listBranches()) {
    const target = commitMappings.get(branch.head);
    if (!target) {
      throw new EngineSpecError(
        "COMPATIBILITY_MISSING_BRANCH_HEAD",
        `Branch head was not migrated: ${branch.head}`,
      );
    }
    const refName = `heads/${branch.name}` as const;
    await engine.publishMigratedRef(refName, target);
    plan.branchMappings.push({ legacyName: branch.name, v2Ref: refName, v2Id: target });
  }

  if (input.traceStore.scheme !== "file") {
    throw new EngineSpecError(
      "COMPATIBILITY_COPY_UNSUPPORTED",
      "The current migration copy requires a file Trace Store",
    );
  }
  await cp(source, path.join(path.resolve(input.traceStore.value), "legacy", "aispec-v0"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  plan.copiedOriginals = true;
  return plan;
}

function snapshotEntry(snapshot: Snapshot): SnapshotEntry {
  const state = structuredClone(snapshot) as unknown as JsonObject;
  return {
    resource: {
      resourceId: snapshot.nodeId,
      type: "aispec.node.v0",
      adapterId: "enginespec.compatibility.aispec-v0",
      adapterVersion: "1",
      locator: { nodeId: snapshot.nodeId },
      restoreClass: "reference-only",
    },
    state: "present",
    contentRefs: [],
    structuredState: state,
  };
}

function legacyIdentity(author: string): Identity {
  return {
    id: `legacy-author:${Buffer.from(author, "utf8").toString("base64url")}`,
    displayName: author,
  };
}

function legacyIdentityId(value: string): string {
  return `legacy-project:${Buffer.from(value, "utf8").toString("base64url")}`;
}

function validateLegacy(_nodeIds: string[], commits: Commit[]): void {
  for (const commit of commits) {
    if (!commit.author.trim()) {
      throw new EngineSpecError("COMPATIBILITY_INVALID_SOURCE", `Commit ${commit.id} has no author`);
    }
  }
}

async function fingerprintDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        hash.update(`D:${relative}\n`);
        await visit(absolute);
      } else if (entry.isFile()) {
        hash.update(`F:${relative}\n`);
        hash.update(await readFile(absolute));
        hash.update("\n");
      } else {
        throw new EngineSpecError(
          "COMPATIBILITY_UNSUPPORTED_ENTRY",
          `Unsupported repository entry: ${relative}`,
        );
      }
    }
  };
  await visit(root);
  return `sha256:${hash.digest("hex")}`;
}

function assertNonOverlapping(source: string, destination: string): void {
  const sourceToDestination = path.relative(source, destination);
  const destinationToSource = path.relative(destination, source);
  if (
    sourceToDestination === "" ||
    destinationToSource === "" ||
    (!sourceToDestination.startsWith(`..${path.sep}`) &&
      sourceToDestination !== ".." &&
      !path.isAbsolute(sourceToDestination)) ||
    (!destinationToSource.startsWith(`..${path.sep}`) &&
      destinationToSource !== ".." &&
      !path.isAbsolute(destinationToSource))
  ) {
    throw new EngineSpecError(
      "COMPATIBILITY_OVERLAPPING_PATHS",
      "Source repository and destination Trace Store must not overlap",
    );
  }
}

