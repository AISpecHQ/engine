import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { RepositoryStorage } from "./storage.js";
import { validateRepository } from "./validation.js";
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

export class AISpecEngine {
  private constructor(private readonly storage: RepositoryStorage) {}

  static create(root: string, options: CreateRepositoryOptions): AISpecEngine {
    if (!options.name.trim()) throw new Error("Repository name is required");
    if (existsSync(path.join(root, "aispec.yaml"))) {
      throw new Error("AISpec repository already exists");
    }

    const storage = RepositoryStorage.initialize(root);
    const manifest: RepositoryManifest = {
      id: `p_${randomUUID()}`,
      name: options.name,
      aispec: { version: options.version ?? "0.1.0" },
    };
    storage.write("aispec.yaml", manifest);

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
    storage.write(storage.pathFor("commits", initialCommit.id), initialCommit);

    const main: Branch = {
      id: `b_${randomUUID()}`,
      name: "main",
      head: initialCommit.id,
      createdAt: now,
      author: options.author ?? "system",
      tags: [],
      metadata: {},
    };
    storage.write(storage.pathFor("branches", main.id), main);
    return new AISpecEngine(storage);
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

  validate(): ValidationResult {
    return validateRepository(this.storage);
  }

  addNode(node: AISpecNode): AISpecNode {
    if (!node || typeof node.id !== "string" || !node.id.trim()) {
      throw new Error("Node id is required");
    }
    if (this.getNode(node.id)) throw new Error(`Node already exists: ${node.id}`);
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
    return this.readAll<Branch>("branches").find((branch) => branch.name === name);
  }

  listBranches(): Branch[] {
    return this.readAll<Branch>("branches").sort((a, b) => a.name.localeCompare(b.name));
  }

  createBranch(input: CreateBranchInput): Branch {
    if (!/^[a-z0-9][a-z0-9/._-]*$/.test(input.name)) {
      throw new Error("Branch name must be lowercase and contain no spaces");
    }
    if (this.getBranch(input.name)) throw new Error(`Branch already exists: ${input.name}`);

    const source = input.from
      ? this.getBranch(input.from) ?? this.getCommit(input.from)
      : this.getBranch("main");
    if (!source) throw new Error(`Branch or commit not found: ${input.from ?? "main"}`);
    const head = "head" in source ? source.head : source.id;
    const branch: Branch = {
      id: `b_${randomUUID()}`,
      name: input.name,
      ...(input.from && this.getBranch(input.from) ? { parent: input.from } : {}),
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
    if (parents.length === 1 && parents[0] !== branch.head) {
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
    this.storage.write(this.storage.pathFor("commits", commit.id), commit);
    this.storage.write(
      this.storage.pathFor("branches", branch.id),
      { ...branch, head: commit.id },
      true,
    );
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
    if (!this.getCommit(commitId)) throw new Error(`Commit not found: ${commitId}`);
    const state = new Map<string, Snapshot>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const commit = this.getCommit(id);
      if (!commit) return;
      for (const snapshotId of commit.snapshotIds) {
        const snapshot = this.getSnapshot(snapshotId);
        if (snapshot && !state.has(snapshot.nodeId)) state.set(snapshot.nodeId, snapshot);
      }
      for (const parent of commit.parents) visit(parent);
    };
    visit(commitId);
    return state;
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
    const commit = this.createCommit({
      branch: options.branch,
      author: options.author,
      message: options.message ?? `Restore ${snapshotId}`,
      snapshotIds: [snapshot.id],
    });
    return { snapshot, commit };
  }

  getChildren(nodeId: string): AISpecNode[] {
    return this.listNodes()
      .filter((node) => node.edges?.some((edge) => edge.source === nodeId))
      .map((node) => this.getNode(
        node.edges!.find((edge) => edge.source === nodeId)!.target,
      ))
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
    const file = this.storage.pathFor(directory, id);
    return this.storage.exists(file) ? this.storage.read<T>(file) : undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
