import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { RepositoryStorage, removeDuringRollback } from "./storage.js";
import {
  validateObject as validateRepositoryObject,
  validateRepository,
} from "./validation.js";
import type {
  AISpecNode,
  Branch,
  Commit,
  CreateBranchInput,
  CreateCommitInput,
  CreateRepositoryOptions,
  CreateSnapshotInput,
  RepositoryManifest,
  RestoreResult,
  Snapshot,
  ValidationResult,
} from "./types.js";

const IDENTITY_DIRECTORIES = [
  "nodes",
  "snapshots",
  "commits",
  "branches",
  "connectors",
  "artifacts",
  "extensions",
] as const;

export class AISpecEngine {
  private constructor(private readonly storage: RepositoryStorage) {}

  static create(root: string, options: CreateRepositoryOptions): AISpecEngine {
    if (!options.name.trim()) throw new Error("Repository name is required");
    if (existsSync(path.join(root, "aispec.yaml"))) {
      throw new Error("AISpec repository already exists");
    }

    const storage = RepositoryStorage.initialize(root);
    const createdFiles: string[] = [];
    const writeInitialFile = (relativePath: string, value: object): void => {
      storage.write(relativePath, value);
      createdFiles.push(relativePath);
    };

    try {
      const manifest: RepositoryManifest = {
        id: `p_${randomUUID()}`,
        name: options.name,
        aispec: { version: options.version ?? "0.1.0" },
      };
      writeInitialFile("aispec.yaml", manifest);

      const now = new Date().toISOString();
      const initialCommit: Commit = {
        id: `c_${randomUUID()}`,
        parents: [],
        branch: "main",
        author: options.author ?? "system",
        timestamp: now,
        message: "Initial commit",
        snapshotIds: [],
        tags: [],
        metadata: {},
      };
      const commitPath = storage.pathFor("commits", initialCommit.id);
      writeInitialFile(commitPath, initialCommit);

      const main: Branch = {
        id: `b_${randomUUID()}`,
        name: "main",
        head: initialCommit.id,
        createdAt: now,
        author: options.author ?? "system",
        tags: [],
        metadata: {},
      };
      writeInitialFile(storage.pathFor("branches", main.id), main);
      return new AISpecEngine(storage);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const relativePath of createdFiles.reverse()) {
        try {
          removeDuringRollback(storage, relativePath);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Repository initialization failed and rollback was incomplete",
        );
      }
      throw error;
    }
  }

  static open(root: string): AISpecEngine {
    const storage = new RepositoryStorage(root);
    if (!storage.exists("aispec.yaml")) {
      throw new Error(`Not an AISpec repository: ${root}`);
    }
    return new AISpecEngine(storage);
  }

  get root(): string {
    return this.storage.root;
  }

  get manifest(): RepositoryManifest {
    return this.storage.read<RepositoryManifest>("aispec.yaml");
  }

  saveRepository(): void {
    this.storage.synchronize();
  }

  validate(): ValidationResult {
    return validateRepository(this.storage);
  }

  validateObject(objectType: string, value: unknown): ValidationResult {
    return validateRepositoryObject(this.storage, objectType, value);
  }

  addNode(node: AISpecNode): AISpecNode {
    if (!node || typeof node.id !== "string" || !node.id.trim()) {
      throw new Error("Node id is required");
    }
    this.assertUniqueObjectId(node.id);
    this.storage.write(this.storage.pathFor("nodes", node.id), node);
    return node;
  }

  getNode(id: string): AISpecNode | undefined {
    return this.findById<AISpecNode>("nodes", id);
  }

  listNodes(): AISpecNode[] {
    return this.readAll<AISpecNode>("nodes").sort((a, b) => a.id.localeCompare(b.id));
  }

  createSnapshot(input: CreateSnapshotInput): Snapshot {
    if (!this.getNode(input.nodeId)) throw new Error(`Node not found: ${input.nodeId}`);
    for (const connectorId of input.connectors ?? []) {
      if (!this.hasStoredId("connectors", connectorId)) {
        throw new Error(`Connector not found: ${connectorId}`);
      }
    }
    for (const artifactId of input.artifacts ?? []) {
      if (!this.hasStoredId("artifacts", artifactId)) {
        throw new Error(`Artifact not found: ${artifactId}`);
      }
    }
    const existing = this.readAll<Snapshot>("snapshots")
      .filter((snapshot) => snapshot.nodeId === input.nodeId);
    const nextVersion = Math.max(0, ...existing.map((snapshot) => snapshot.version)) + 1;
    if (input.version !== undefined && input.version !== nextVersion) {
      throw new Error(`Snapshot version must be the next version (${nextVersion})`);
    }
    if (!isRecord(input.configuration)) {
      throw new Error("Snapshot configuration must be an object");
    }

    const snapshot: Snapshot = {
      id: `s_${randomUUID()}`,
      nodeId: input.nodeId,
      version: nextVersion,
      createdAt: new Date().toISOString(),
      configuration: input.configuration,
      capabilities: input.capabilities ?? [],
      connectors: input.connectors ?? [],
      artifacts: input.artifacts ?? [],
      metadata: input.metadata ?? {},
    };
    this.storage.write(this.storage.pathFor("snapshots", snapshot.id), snapshot);
    return snapshot;
  }

  getSnapshot(id: string): Snapshot | undefined {
    return this.findById<Snapshot>("snapshots", id);
  }

  listSnapshots(nodeId?: string): Snapshot[] {
    return this.readAll<Snapshot>("snapshots")
      .filter((snapshot) => !nodeId || snapshot.nodeId === nodeId)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.version - b.version);
  }

  getBranch(name: string): Branch | undefined {
    return this.readAll<Branch>("branches")
      .find((branch) => branch.name === name || branch.id === name);
  }

  listBranches(): Branch[] {
    return this.readAll<Branch>("branches").sort((a, b) => a.name.localeCompare(b.name));
  }

  createBranch(input: CreateBranchInput): Branch {
    if (!/^[a-z0-9][a-z0-9/._-]*$/.test(input.name)) {
      throw new Error("Branch name must be lowercase and contain no spaces");
    }
    if (this.getBranch(input.name)) throw new Error(`Branch already exists: ${input.name}`);

    const sourceBranch = input.from
      ? this.getBranch(input.from)
      : this.getBranch("main");
    const source = sourceBranch ?? (input.from ? this.getCommit(input.from) : undefined);
    if (!source) throw new Error(`Branch or commit not found: ${input.from ?? "main"}`);
    const head = "head" in source ? source.head : source.id;
    const parentName = sourceBranch?.name ??
      ("branch" in source ? this.getBranch(source.branch)?.name : undefined);
    const branch: Branch = {
      id: `b_${randomUUID()}`,
      name: input.name,
      ...(parentName ? { parent: parentName } : {}),
      head,
      createdAt: new Date().toISOString(),
      author: input.author,
      ...(input.description ? { description: input.description } : {}),
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    };
    this.storage.write(this.storage.pathFor("branches", branch.id), branch);
    return branch;
  }

  getCommit(id: string): Commit | undefined {
    return this.findById<Commit>("commits", id);
  }

  listCommits(): Commit[] {
    return this.readAll<Commit>("commits")
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  }

  createCommit(input: CreateCommitInput): Commit {
    if (!input.message.trim() || !input.author.trim()) {
      throw new Error("Commit message and author are required");
    }
    const branchName = input.branch ?? "main";
    const branch = this.getBranch(branchName);
    if (!branch) throw new Error(`Branch not found: ${branchName}`);
    const parents = input.parents ?? [branch.head];
    if (!parents.includes(branch.head)) {
      throw new Error("A commit must include the current branch head as its parent");
    }
    if (new Set(parents).size !== parents.length) throw new Error("Commit parents must be unique");
    for (const parent of parents) {
      if (!this.getCommit(parent)) throw new Error(`Parent commit not found: ${parent}`);
    }
    const snapshotIds = input.snapshotIds ?? [];
    for (const id of snapshotIds) {
      if (!this.getSnapshot(id)) throw new Error(`Snapshot not found: ${id}`);
    }

    const commit: Commit = {
      id: `c_${randomUUID()}`,
      parents,
      branch: branchName,
      author: input.author,
      timestamp: new Date().toISOString(),
      message: input.message,
      snapshotIds,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    };
    const commitPath = this.storage.pathFor("commits", commit.id);
    this.storage.write(commitPath, commit);
    try {
      this.storage.write(
        this.storage.pathFor("branches", branch.id),
        { ...branch, head: commit.id },
        true,
      );
    } catch (cause) {
      try {
        removeDuringRollback(this.storage, commitPath);
      } catch (rollbackCause) {
        throw new AggregateError(
          [cause, rollbackCause],
          `Failed to advance branch ${branchName} and remove incomplete commit ${commit.id}`,
        );
      }
      throw cause;
    }
    return commit;
  }

  mergeBranches(sourceName: string, targetName: string, author: string, message: string): Commit {
    const source = this.getBranch(sourceName);
    const target = this.getBranch(targetName);
    if (!source || !target) throw new Error("Both source and target branches must exist");
    if (source.id === target.id) throw new Error("Cannot merge a branch into itself");
    return this.createCommit({
      branch: targetName,
      parents: [target.head, source.head],
      author,
      message,
    });
  }

  getStateAtCommit(commitId: string): Map<string, Snapshot> {
    const states = new Map<string, Map<string, Snapshot>>();
    const readCommit = (id: string): Commit => {
      let commit: Commit | undefined;
      try {
        commit = this.getCommit(id);
      } catch (cause) {
        throw new Error(
          `Failed to read commit ${id} while reconstructing repository state: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        );
      }
      if (!commit) throw new Error(`Commit not found: ${id}`);
      return commit;
    };
    const readSnapshot = (id: string): Snapshot => {
      let snapshot: Snapshot | undefined;
      try {
        snapshot = this.getSnapshot(id);
      } catch (cause) {
        throw new Error(
          `Failed to read snapshot ${id} while reconstructing repository state: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        );
      }
      if (!snapshot) throw new Error(`Snapshot not found: ${id}`);
      return snapshot;
    };
    const stateAt = (id: string, active = new Set<string>()): Map<string, Snapshot> => {
      const cached = states.get(id);
      if (cached) return new Map(cached);
      if (active.has(id)) throw new Error(`Commit history cycle detected: ${id}`);

      const commit = readCommit(id);
      const nextActive = new Set(active).add(id);
      const state = new Map<string, Snapshot>();
      for (const parent of commit.parents) {
        for (const [nodeId, snapshot] of stateAt(parent, nextActive)) {
          if (!state.has(nodeId)) state.set(nodeId, snapshot);
        }
      }
      for (const snapshotId of commit.snapshotIds) {
        const snapshot = readSnapshot(snapshotId);
        state.set(snapshot.nodeId, snapshot);
      }
      states.set(id, state);
      return new Map(state);
    };
    return stateAt(commitId);
  }

  restoreSnapshot(
    snapshotId: string,
    options: { author: string; message?: string; branch?: string },
  ): { snapshot: Snapshot; commit: Commit } {
    const previous = this.getSnapshot(snapshotId);
    if (!previous) throw new Error(`Snapshot not found: ${snapshotId}`);
    const snapshot = this.createSnapshot({
      nodeId: previous.nodeId,
      configuration: structuredClone(previous.configuration),
      capabilities: [...previous.capabilities],
      connectors: [...previous.connectors],
      artifacts: [...previous.artifacts],
      metadata: structuredClone(previous.metadata),
    });
    try {
      const commit = this.createCommit({
        branch: options.branch,
        author: options.author,
        message: options.message ?? `Restore ${snapshotId}`,
        snapshotIds: [snapshot.id],
      });
      return { snapshot, commit };
    } catch (cause) {
      try {
        removeDuringRollback(
          this.storage,
          this.storage.pathFor("snapshots", snapshot.id),
        );
      } catch (rollbackCause) {
        throw new AggregateError(
          [cause, rollbackCause],
          `Failed to restore snapshot ${snapshotId} and remove incomplete snapshot ${snapshot.id}`,
        );
      }
      throw cause;
    }
  }

  getChildren(nodeId: string): AISpecNode[] {
    const childIds = new Set(
      this.listNodes().flatMap((node) =>
        (node.edges ?? [])
          .filter((edge) => edge.source === nodeId)
          .map((edge) => edge.target),
      ),
    );
    return [...childIds]
      .map((id) => this.getNode(id))
      .filter((node): node is AISpecNode => Boolean(node))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  getParents(nodeId: string): AISpecNode[] {
    return this.listNodes()
      .filter((node) => node.edges?.some((edge) => edge.target === nodeId))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  traverse(startNodeId: string): AISpecNode[] {
    if (!this.getNode(startNodeId)) throw new Error(`Node not found: ${startNodeId}`);
    const result: AISpecNode[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = this.getNode(id);
      if (!node) return;
      result.push(node);
      for (const child of this.getChildren(id)) visit(child.id);
    };
    visit(startNodeId);
    return result;
  }

  private readAll<T>(directory: string): T[] {
    return this.storage.list(directory).map((file) => this.storage.read<T>(file));
  }

  private findById<T extends { id: string }>(directory: string, id: string): T | undefined {
    let result: T | undefined;
    for (const file of this.storage.list(directory)) {
      const object = this.storage.read<T>(file);
      if (object.id !== id) continue;
      if (result) throw new Error(`Duplicate ${directory} object id: ${id}`);
      result = object;
    }
    return result;
  }

  private assertUniqueObjectId(id: string): void {
    for (const directory of IDENTITY_DIRECTORIES) {
      let files: string[];
      try {
        files = this.storage.list(directory);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `Cannot verify unique ID ${id}; could not list ${directory}: ${detail}`,
          { cause },
        );
      }
      for (const file of files) {
        let object: unknown;
        try {
          object = this.storage.read(file);
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          throw new Error(
            `Cannot verify unique ID ${id}; could not inspect ${directory} object ${file}: ${detail}`,
            { cause },
          );
        }
        if (!isRecord(object) || typeof object.id !== "string" || !object.id.trim()) {
          throw new Error(
            `Cannot verify unique ID ${id}; ${directory} object ${file} has no valid ID`,
          );
        }
        if (object.id === id) {
          if (directory === "nodes") throw new Error(`Node already exists: ${id}`);
          throw new Error(`Object ID is already used in ${directory}: ${id}`);
        }
      }
    }
  }

  private hasStoredId(directory: "connectors" | "artifacts", id: string): boolean {
    return this.readAll<Record<string, unknown>>(directory)
      .some((object) => object.id === id);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
