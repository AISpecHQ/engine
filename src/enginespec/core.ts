import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  AdapterRegistry,
  FilesystemAdapter,
  StructuredAdapter,
  type DiffChange,
  type ResourceConflict,
  type ResourceSelector,
  type RestoreTarget,
} from "./adapters.js";
import { FileBinaryInput, LocalContentStore } from "./cas.js";
import { EngineSpecError } from "./errors.js";
import { type SignatureProvider, verifyEngineSpecSignature } from "./identity.js";
import type {
  CommitPayload,
  ContentRef,
  EntityId,
  Identity,
  IntegrityReport,
  Issue,
  ObjectId,
  ObjectKind,
  ObjectRef,
  ProvenancePayload,
  Ref,
  SignaturePayload,
  SnapshotEntry,
  SnapshotPayload,
  StoreLocator,
  ValidationResult,
  Workspace,
  WorkspaceBinding,
} from "./model.js";
import { LocalTraceStore } from "./store.js";

export interface InitializeInput {
  name: string;
  workspace: string;
  traceStore: StoreLocator;
  projectId?: EntityId;
}

export interface OpenInput {
  workspace?: string;
  traceStore?: StoreLocator;
}

export interface CaptureInput {
  adapterId?: string;
  selectors: ResourceSelector[];
}

export interface CommitInput {
  snapshotId: ObjectId;
  ref: Ref["name"];
  expectedHead: ObjectId | null;
  expectedGeneration: number;
  author: Identity;
  message: string;
  tags?: string[];
  signerId?: string;
}

export interface MergeInput {
  sourceCommitId: ObjectId;
  targetRef: Ref["name"];
  expectedTargetHead: ObjectId;
  expectedTargetGeneration: number;
  author: Identity;
  message: string;
  signerId?: string;
}

export interface RestoreInput {
  snapshotId: ObjectId;
  target: RestoreTarget;
  mode: "dry-run" | "materialize" | "commit";
  ref?: Ref["name"];
  expectedHead?: ObjectId | null;
  expectedGeneration?: number;
  author?: Identity;
  message?: string;
  signerId?: string;
}

export type MergeResult =
  | { status: "merged"; commit: ObjectRef; snapshot: ObjectRef; ref: Ref }
  | {
      status: "conflicts";
      sourceCommitId: ObjectId;
      targetHead: ObjectId;
      conflicts: ResourceConflict[];
    };

export interface RestoreResult {
  mode: RestoreInput["mode"];
  status: "restored" | "partial";
  restored: string[];
  skipped: Array<{ resourceId: string; reason: string }>;
  commit?: ObjectRef;
  ref?: Ref;
  provenanceRefs: ObjectId[];
}

export interface ExportBundleInput {
  destination: string;
  refs?: Ref["name"][];
  roots?: ObjectId[];
}

export interface ImportBundleInput {
  bundle: string;
  refs?: Array<{
    source: Ref["name"];
    target: Ref["name"];
    expectedTargetHead: ObjectId | null;
    expectedTargetGeneration: number;
  }>;
}

export interface BundleResult {
  objects: number;
  contents: number;
  refs: Ref[];
}

export class EngineSpecEngine {
  private readonly signers = new Map<string, SignatureProvider>();

  private constructor(
    readonly workspace: Workspace,
    private readonly store: LocalTraceStore,
    private readonly content: LocalContentStore,
    private readonly adapters: AdapterRegistry,
  ) {}

  static async initialize(
    input: InitializeInput,
    registry = defaultAdapterRegistry(),
  ): Promise<EngineSpecEngine> {
    if (!input.name.trim()) throw new EngineSpecError("CORE_INVALID_NAME", "Project name is required");
    const root = path.resolve(input.workspace);
    const traceStore = locatorPath(input.traceStore);
    await mkdir(root, { recursive: true });
    const store = new LocalTraceStore(traceStore);
    const projectId = input.projectId ?? randomUUID();
    await store.initialize(projectId);
    const content = new LocalContentStore(traceStore);
    await content.initialize();
    await store.put("project", {
      projectId,
      name: input.name,
    });
    const binding: WorkspaceBinding = {
      format: "enginespec-workspace",
      formatVersion: "2.0",
      workspaceId: randomUUID(),
      projectId,
      activeTraceStore: input.traceStore,
    };
    await writeBinding(root, binding);
    return new EngineSpecEngine(
      {
        workspaceId: binding.workspaceId,
        projectId,
        location: root,
        traceStore: input.traceStore,
      },
      store,
      content,
      registry,
    );
  }

  static async open(
    input: OpenInput,
    registry = defaultAdapterRegistry(),
  ): Promise<EngineSpecEngine> {
    const root = input.workspace ? path.resolve(input.workspace) : undefined;
    const binding = root ? await readBinding(root) : undefined;
    const locator = input.traceStore ?? binding?.activeTraceStore;
    if (!locator) {
      throw new EngineSpecError(
        "WORKSPACE_BINDING_NOT_FOUND",
        "Provide a Trace Store locator or open a bound workspace",
      );
    }
    const traceStore = locatorPath(locator);
    const store = new LocalTraceStore(traceStore);
    await store.open();
    const content = new LocalContentStore(traceStore);
    await content.initialize();
    const manifest = await readManifest(traceStore);
    const projectId = binding?.projectId ?? manifest.projectId;
    if (binding && binding.projectId !== manifest.projectId) {
      throw new EngineSpecError(
        "WORKSPACE_PROJECT_MISMATCH",
        "Workspace binding belongs to a different Trace Store",
      );
    }
    return new EngineSpecEngine(
      {
        workspaceId: binding?.workspaceId ?? `workspace:${randomUUID()}`,
        projectId,
        location: root ?? path.resolve(locator.value),
        traceStore: locator,
      },
      store,
      content,
      registry,
    );
  }

  registerSigner(provider: SignatureProvider): void {
    this.signers.set(provider.id, provider);
  }

  registerAdapter(adapter: Parameters<AdapterRegistry["register"]>[0]): void {
    this.adapters.register(adapter);
  }

  async get(reference: ObjectRef): Promise<SnapshotPayload | CommitPayload | ProvenancePayload | SignaturePayload | Record<string, unknown>> {
    return (await this.store.get(reference)).payload as
      SnapshotPayload | CommitPayload | ProvenancePayload | SignaturePayload | Record<string, unknown>;
  }

  /** @internal Used by explicit compatibility migrations. */
  async importMigratedObject<T extends object>(
    kind: ObjectKind,
    payload: T,
  ): Promise<ObjectRef> {
    return this.store.put(kind, payload);
  }

  /** @internal Used by explicit compatibility migrations. */
  async publishMigratedRef(name: Ref["name"], target: ObjectId): Promise<Ref> {
    return this.publish(target, { name, target: null, generation: 0 });
  }

  async getRef(name: Ref["name"]): Promise<Ref | null> {
    return this.store.getRef(name);
  }

  async listRefs(prefix?: "heads/" | "tags/"): Promise<Ref[]> {
    return this.store.listRefs(prefix);
  }

  async listObjects(kind?: ObjectKind): Promise<ObjectRef[]> {
    const result: ObjectRef[] = [];
    for await (const reference of this.store.list(kind)) result.push(reference);
    return result;
  }

  async capture(input: CaptureInput): Promise<ObjectRef> {
    const adapters = this.resolveAdapters(input.selectors, input.adapterId);
    const entries: SnapshotEntry[] = [];
    for (const [adapter, selectors] of adapters) {
      const captured = await adapter.capture(selectors, {
        workspaceRoot: this.workspace.location,
        content: this.content,
      });
      entries.push(...captured);
    }
    entries.sort((left, right) =>
      left.resource.resourceId.localeCompare(right.resource.resourceId));
    assertUniqueResources(entries);
    const provenance = await this.createProvenance({
      actor: { id: `workspace:${this.workspace.workspaceId}` },
      action: "captured",
      occurredAt: new Date().toISOString(),
      inputs: [],
      outputs: [],
      ...(input.adapterId
        ? { adapter: { id: input.adapterId, version: this.requireAdapter(input.adapterId).version } }
        : {}),
    });
    const snapshot: SnapshotPayload = {
      projectId: this.workspace.projectId,
      createdAt: new Date().toISOString(),
      entries,
      provenanceRefs: [provenance.id],
    };
    const reference = await this.store.put("snapshot", snapshot);
    return reference;
  }

  async commit(input: CommitInput): Promise<{ commit: ObjectRef; ref: Ref }> {
    validateCommitInput(input);
    const snapshot = await this.readSnapshot(input.snapshotId);
    const current = await this.store.getRef(input.ref);
    if (current && current.target !== input.expectedHead) {
      throw staleRef(input.ref, input.expectedHead, current.target);
    }
    if (input.expectedHead !== null && !current) {
      throw staleRef(input.ref, input.expectedHead, null);
    }
    const parents = input.expectedHead === null ? [] : [input.expectedHead];
    const payload: CommitPayload = {
      projectId: this.workspace.projectId,
      parents,
      snapshotId: snapshot.reference.id,
      author: input.author,
      timestamp: new Date().toISOString(),
      message: input.message.trim(),
      tags: [...new Set(input.tags ?? [])].sort(),
      provenanceRefs: snapshot.payload.provenanceRefs,
    };
    const reference = await this.store.put("commit", payload);
    if (input.signerId) await this.signCommit(reference, input.author, input.signerId);
    const ref = await this.publish(reference.id, {
      name: input.ref,
      target: input.expectedHead,
      generation: input.expectedGeneration,
    });
    return { commit: reference, ref };
  }

  async branch(input: { name: string; from: ObjectId }): Promise<Ref> {
    const commit = await this.requireCommit(input.from);
    if (commit.payload.projectId !== this.workspace.projectId) {
      throw new EngineSpecError("CORE_PROJECT_MISMATCH", "Commit belongs to another project");
    }
    const name = normalizeHeadName(input.name);
    return this.publish(input.from, { name, target: null, generation: 0 });
  }

  async tag(input: { name: string; target: ObjectId }): Promise<Ref> {
    await this.requireCommit(input.target);
    const name = normalizeTagName(input.name);
    return this.publish(input.target, { name, target: null, generation: 0 });
  }

  async compare(input: {
    from: { kind: "commit" | "snapshot"; id: ObjectId };
    to: { kind: "commit" | "snapshot"; id: ObjectId };
  }): Promise<{ changes: DiffChange[]; unsupported: string[] }> {
    const before = await this.snapshotFromTarget(input.from);
    const after = await this.snapshotFromTarget(input.to);
    const left = new Map(before.payload.entries.map((entry) => [entry.resource.resourceId, entry]));
    const right = new Map(after.payload.entries.map((entry) => [entry.resource.resourceId, entry]));
    const changes: DiffChange[] = [];
    const unsupported: string[] = [];
    for (const resourceId of new Set([...left.keys(), ...right.keys()])) {
      const beforeEntry = left.get(resourceId) ?? null;
      const afterEntry = right.get(resourceId) ?? null;
      const adapterId = afterEntry?.resource.adapterId ?? beforeEntry?.resource.adapterId;
      if (!adapterId) continue;
      const adapter = this.requireAdapter(adapterId);
      const result = await adapter.compare(beforeEntry, afterEntry, this.adapterContext());
      changes.push(...result.changes);
      unsupported.push(...result.unsupported);
    }
    return { changes, unsupported: [...new Set(unsupported)].sort() };
  }

  async merge(input: MergeInput): Promise<MergeResult> {
    const targetRef = await this.store.getRef(input.targetRef);
    if (!targetRef ||
        targetRef.target !== input.expectedTargetHead ||
        targetRef.generation !== input.expectedTargetGeneration) {
      throw staleRef(input.targetRef, input.expectedTargetHead, targetRef?.target ?? null);
    }
    const target = await this.requireCommit(input.expectedTargetHead);
    const source = await this.requireCommit(input.sourceCommitId);
    const baseId = await this.commonAncestor(target.reference.id, source.reference.id);
    if (!baseId) throw new EngineSpecError("STORE_UNRELATED_HISTORY", "Branches have no common ancestor");
    const baseSnapshot = await this.readSnapshot((await this.requireCommit(baseId)).payload.snapshotId);
    const oursSnapshot = await this.readSnapshot(target.payload.snapshotId);
    const theirsSnapshot = await this.readSnapshot(source.payload.snapshotId);
    const mergedEntries: SnapshotEntry[] = [];
    const conflicts: ResourceConflict[] = [];
    const allResources = [...new Set([
      ...baseSnapshot.payload.entries.map((entry) => entry.resource.resourceId),
      ...oursSnapshot.payload.entries.map((entry) => entry.resource.resourceId),
      ...theirsSnapshot.payload.entries.map((entry) => entry.resource.resourceId),
    ])].sort();
    const base = indexEntries(baseSnapshot.payload.entries);
    const ours = indexEntries(oursSnapshot.payload.entries);
    const theirs = indexEntries(theirsSnapshot.payload.entries);
    for (const resourceId of allResources) {
      const left = ours.get(resourceId) ?? null;
      const right = theirs.get(resourceId) ?? null;
      const original = base.get(resourceId) ?? null;
      const adapterId = left?.resource.adapterId ?? right?.resource.adapterId ?? original?.resource.adapterId;
      if (!adapterId) continue;
      const result = await this.requireAdapter(adapterId).merge(
        original,
        left,
        right,
        this.adapterContext(),
      );
      if (result.status === "resolved") mergedEntries.push(result.entry);
      else if (result.status === "conflicts") conflicts.push(...result.conflicts);
      else conflicts.push({
        resourceId,
        kind: "adapter-merge-unsupported",
        reason: result.reason,
        ...(original ? { base: original } : {}),
        ...(left ? { ours: left } : {}),
        ...(right ? { theirs: right } : {}),
      });
    }
    if (conflicts.length > 0) {
      return {
        status: "conflicts",
        sourceCommitId: source.reference.id,
        targetHead: target.reference.id,
        conflicts,
      };
    }
    const provenance = await this.createProvenance({
      actor: input.author,
      action: "merged",
      occurredAt: new Date().toISOString(),
      inputs: [target.reference, source.reference],
      outputs: [],
    });
    const snapshot = await this.store.put("snapshot", {
      projectId: this.workspace.projectId,
      createdAt: new Date().toISOString(),
      entries: mergedEntries,
      provenanceRefs: [provenance.id],
    } satisfies SnapshotPayload);
    const commit = await this.store.put("commit", {
      projectId: this.workspace.projectId,
      parents: [target.reference.id, source.reference.id],
      snapshotId: snapshot.id,
      author: input.author,
      timestamp: new Date().toISOString(),
      message: input.message,
      tags: [],
      provenanceRefs: [provenance.id],
    } satisfies CommitPayload);
    if (input.signerId) await this.signCommit(commit, input.author, input.signerId);
    const ref = await this.publish(commit.id, {
      name: input.targetRef,
      target: input.expectedTargetHead,
      generation: input.expectedTargetGeneration,
    });
    return { status: "merged", commit, snapshot, ref };
  }

  async restore(input: RestoreInput): Promise<RestoreResult> {
    const snapshot = await this.readSnapshot(input.snapshotId);
    const grouped = groupByAdapter(snapshot.payload.entries);
    const restored: string[] = [];
    const skipped: RestoreResult["skipped"] = [];
    if (input.mode === "dry-run") {
      return {
        mode: input.mode,
        status: "restored",
        restored: snapshot.payload.entries.map((entry) => entry.resource.resourceId),
        skipped,
        provenanceRefs: [],
      };
    }
    for (const [adapterId, entries] of grouped) {
      const result = await this.requireAdapter(adapterId).restore(
        entries,
        input.target,
        this.adapterContext(),
      );
      restored.push(...result.restored);
      skipped.push(...result.skipped);
    }
    if (input.mode === "materialize") {
      return {
        mode: input.mode,
        status: skipped.length === 0 ? "restored" : "partial",
        restored,
        skipped,
        provenanceRefs: [],
      };
    }
    if (!input.ref || !input.author || !input.message ||
        input.expectedGeneration === undefined || input.expectedHead === undefined) {
      throw new EngineSpecError(
        "CORE_INCOMPLETE_RESTORE_COMMIT",
        "Commit restore requires ref, expected state, author and message",
      );
    }
    const provenance = await this.createProvenance({
      actor: input.author,
      action: "restored",
      occurredAt: new Date().toISOString(),
      inputs: [snapshot.reference],
      outputs: [],
    });
    const restoredSnapshot = await this.store.put("snapshot", {
      ...snapshot.payload,
      createdAt: new Date().toISOString(),
      provenanceRefs: [provenance.id],
    } satisfies SnapshotPayload);
    const result = await this.commit({
      snapshotId: restoredSnapshot.id,
      ref: input.ref,
      expectedHead: input.expectedHead,
      expectedGeneration: input.expectedGeneration,
      author: input.author,
      message: input.message,
      signerId: input.signerId,
    });
    return {
      mode: input.mode,
      status: skipped.length === 0 ? "restored" : "partial",
      restored,
      skipped,
      commit: result.commit,
      ref: result.ref,
      provenanceRefs: [provenance.id],
    };
  }

  async exportBundle(input: ExportBundleInput): Promise<BundleResult> {
    const destination = path.resolve(input.destination);
    await mkdir(destination, { recursive: false });
    await mkdir(path.join(destination, "objects"), { recursive: true });
    await mkdir(path.join(destination, "cas"), { recursive: true });
    const refs = input.refs
      ? await Promise.all(input.refs.map(async (name) => {
          const ref = await this.store.getRef(name);
          if (!ref) throw new EngineSpecError("STORE_REF_NOT_FOUND", `Ref not found: ${name}`);
          return ref;
        }))
      : await this.store.listRefs();
    const roots = [...new Set([
      ...(input.roots ?? []),
      ...refs.map((ref) => ref.target),
    ])];
    const objects = await this.reachableObjects(roots);
    const addresses = await this.reachableContents(objects);
    const objectIds: ObjectRef[] = [...objects.values()];
    for (const reference of objectIds) {
      const envelope = await this.store.get(reference);
      const directory = path.join(destination, "objects", reference.kind);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, `${reference.id.slice(7)}.json`),
        `${JSON.stringify(envelope)}\n`,
        "utf8",
      );
    }
    for (const contentRef of addresses) {
      const address = contentRef.address;
      const directory = path.join(
        destination,
        "cas",
        "sha256",
        address.digest.slice(0, 2),
        address.digest.slice(2, 4),
      );
      await mkdir(directory, { recursive: true });
      await this.contentMaterialize(address, path.join(directory, address.digest));
    }
    const manifest = {
      format: "enginespec-bundle",
      formatVersion: "1",
      projectId: this.workspace.projectId,
      objects: objectIds,
      contents: addresses,
      refs,
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(destination, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    return { objects: objectIds.length, contents: addresses.length, refs };
  }

  async importBundle(input: ImportBundleInput): Promise<BundleResult> {
    const bundle = path.resolve(input.bundle);
    const manifest = await readBundleManifest(bundle);
    if (manifest.projectId !== this.workspace.projectId) {
      throw new EngineSpecError("BUNDLE_PROJECT_MISMATCH", "Bundle belongs to another project");
    }
    for (const contentRef of manifest.contents) {
      const address = contentRef.address;
      const source = path.join(
        bundle,
        "cas",
        "sha256",
        address.digest.slice(0, 2),
        address.digest.slice(2, 4),
        address.digest,
      );
      const info = await lstat(source);
      if (!info.isFile() || info.size !== address.size) {
        throw new EngineSpecError("BUNDLE_CONTENT_INVALID", `Invalid bundle content: ${address.digest}`);
      }
      await this.content.put(new FileBinaryInput(source));
      if (!(await this.content.verify(address))) {
        throw new EngineSpecError("BUNDLE_CONTENT_INVALID", `Corrupt bundle content: ${address.digest}`);
      }
    }
    for (const reference of manifest.objects) {
      const file = path.join(bundle, "objects", reference.kind, `${reference.id.slice(7)}.json`);
      const parsed = JSON.parse(await readFile(file, "utf8")) as { payload?: object };
      if (!parsed.payload) {
        throw new EngineSpecError("BUNDLE_OBJECT_INVALID", `Invalid bundle object: ${reference.id}`);
      }
      const imported = await this.store.put(reference.kind, parsed.payload);
      if (imported.id !== reference.id) {
        throw new EngineSpecError("BUNDLE_OBJECT_MISMATCH", `Bundle object ID changed: ${reference.id}`);
      }
    }
    const updated: Ref[] = [];
    for (const requested of input.refs ?? []) {
      const source = manifest.refs.find((ref: Ref) => ref.name === requested.source);
      if (!source) {
        throw new EngineSpecError("BUNDLE_REF_NOT_FOUND", `Bundle ref not found: ${requested.source}`);
      }
      updated.push(await this.store.compareAndSwapRef(
        {
          name: requested.target,
          target: requested.expectedTargetHead,
          generation: requested.expectedTargetGeneration,
        },
        source.target,
      ));
    }
    return { objects: manifest.objects.length, contents: manifest.contents.length, refs: updated };
  }

  async validate(reference: ObjectRef): Promise<ValidationResult> {
    const issues: Issue[] = [];
    try {
      const envelope = await this.store.get(reference);
      if (reference.kind === "snapshot") {
        const payload = envelope.payload as unknown as SnapshotPayload;
        const ids = new Set<string>();
        for (const entry of payload.entries) {
          if (ids.has(entry.resource.resourceId)) {
            issues.push(issue("error", "SNAPSHOT_DUPLICATE_RESOURCE",
              `Duplicate resource: ${entry.resource.resourceId}`, reference.id));
          }
          ids.add(entry.resource.resourceId);
          for (const content of entry.contentRefs) {
            if (!(await this.content.verify(content.address))) {
              issues.push(issue("error", "CAS_DIGEST_MISMATCH",
                `Invalid CAS reference: ${content.address.digest}`, reference.id));
            }
          }
        }
      }
      if (reference.kind === "commit") {
        const payload = envelope.payload as unknown as CommitPayload;
        if (payload.projectId !== this.workspace.projectId) {
          issues.push(issue("error", "CORE_PROJECT_MISMATCH", "Commit project does not match"));
        }
        await this.readSnapshot(payload.snapshotId);
        if (new Set(payload.parents).size !== payload.parents.length) {
          issues.push(issue("error", "COMMIT_DUPLICATE_PARENT", "Duplicate commit parent"));
        }
        for (const parent of payload.parents) await this.requireCommit(parent);
      }
    } catch (cause) {
      issues.push(issue(
        "error",
        cause instanceof EngineSpecError ? cause.code : "VALIDATION_FAILED",
        cause instanceof Error ? cause.message : String(cause),
        reference.id,
      ));
    }
    return { valid: !issues.some((item) => item.severity === "error"), issues };
  }

  async verify(reference: ObjectRef, mode: "quick" | "deep" | "history" = "deep"): Promise<IntegrityReport> {
    const validation = await this.validate(reference);
    const issues = [...validation.issues];
    if (mode === "history" && reference.kind === "commit") {
      const visited = new Set<ObjectId>();
      const pending = [reference.id];
      while (pending.length > 0) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const commit = await this.requireCommit(id);
        const commitValidation = await this.validate(commit.reference);
        issues.push(...commitValidation.issues);
        pending.push(...commit.payload.parents);
      }
    }
    const signatures = await this.signaturesFor(reference);
    return {
      valid: !issues.some((item) => item.severity === "error") &&
        !signatures.some((status) => status.cryptographic === "invalid"),
      issues,
      signatures,
    };
  }

  private async signCommit(reference: ObjectRef, identity: Identity, signerId: string): Promise<void> {
    const signer = this.signers.get(signerId);
    if (!signer) throw new EngineSpecError("IDENTITY_SIGNER_NOT_FOUND", `Signer not found: ${signerId}`);
    const envelope = await signer.sign(identity, reference, reference.id);
    await this.store.put("signature", { target: reference, envelope } satisfies SignaturePayload);
  }

  private async signaturesFor(target: ObjectRef): Promise<IntegrityReport["signatures"]> {
    const result: IntegrityReport["signatures"] = [];
    for await (const reference of this.store.list("signature")) {
      const payload = (await this.store.get(reference)).payload as unknown as SignaturePayload;
      if (payload.target.id === target.id && payload.target.kind === target.kind) {
        result.push({
          target,
          signature: reference.id,
          cryptographic: verifyEngineSpecSignature(payload.envelope, target, target.id),
          trust: "unknown",
        });
      }
    }
    if (result.length === 0) {
      result.push({ target, cryptographic: "unsigned", trust: "not-evaluated" });
    }
    return result;
  }

  private async publish(target: ObjectId, expected: Parameters<LocalTraceStore["compareAndSwapRef"]>[0]): Promise<Ref> {
    const transactionId = await this.store.beginTransaction();
    await this.store.markReady(transactionId, expected, target);
    return this.store.commitTransaction(transactionId);
  }

  private async readSnapshot(id: ObjectId): Promise<{ reference: ObjectRef; payload: SnapshotPayload }> {
    const reference = { kind: "snapshot", id } as const;
    const envelope = await this.store.get(reference);
    const payload = envelope.payload as unknown as SnapshotPayload;
    if (payload.projectId !== this.workspace.projectId) {
      throw new EngineSpecError("CORE_PROJECT_MISMATCH", "Snapshot belongs to another project");
    }
    return { reference, payload };
  }

  private async requireCommit(id: ObjectId): Promise<{ reference: ObjectRef; payload: CommitPayload }> {
    const reference = { kind: "commit", id } as const;
    const payload = (await this.store.get(reference)).payload as unknown as CommitPayload;
    if (payload.projectId !== this.workspace.projectId) {
      throw new EngineSpecError("CORE_PROJECT_MISMATCH", "Commit belongs to another project");
    }
    return { reference, payload };
  }

  private async snapshotFromTarget(
    target: { kind: "commit" | "snapshot"; id: ObjectId },
  ): ReturnType<EngineSpecEngine["readSnapshot"]> {
    if (target.kind === "snapshot") return this.readSnapshot(target.id);
    const commit = await this.requireCommit(target.id);
    return this.readSnapshot(commit.payload.snapshotId);
  }

  private async commonAncestor(leftId: ObjectId, rightId: ObjectId): Promise<ObjectId | undefined> {
    const queue: ObjectId[] = [leftId];
    const leftSet = new Set<ObjectId>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (leftSet.has(id)) continue;
      leftSet.add(id);
      queue.push(...(await this.requireCommit(id)).payload.parents);
    }
    queue.push(rightId);
    const visited = new Set<ObjectId>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (leftSet.has(id)) return id;
      queue.push(...(await this.requireCommit(id)).payload.parents);
    }
    return undefined;
  }

  private async createProvenance(payload: ProvenancePayload): Promise<ObjectRef> {
    return this.store.put("provenance", payload);
  }

  private resolveAdapters(
    selectors: ResourceSelector[],
    requested?: string,
  ): Map<ReturnType<EngineSpecEngine["requireAdapter"]>, ResourceSelector[]> {
    const result = new Map<ReturnType<EngineSpecEngine["requireAdapter"]>, ResourceSelector[]>();
    for (const selector of selectors) {
      const adapter = requested ? this.requireAdapter(requested) : this.adapters.find(selector.type);
      if (!adapter) {
        throw new EngineSpecError("ADAPTER_NOT_FOUND", `No adapter for ${selector.type}`);
      }
      if (!adapter.resourceTypes.includes(selector.type)) {
        throw new EngineSpecError(
          "ADAPTER_TYPE_UNSUPPORTED",
          `${adapter.id} does not support ${selector.type}`,
        );
      }
      const grouped = result.get(adapter) ?? [];
      grouped.push(selector);
      result.set(adapter, grouped);
    }
    return result;
  }

  private requireAdapter(id: string) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new EngineSpecError("ADAPTER_NOT_FOUND", `Adapter not found: ${id}`);
    return adapter;
  }

  private adapterContext() {
    return { workspaceRoot: this.workspace.location, content: this.content };
  }

  private async reachableObjects(roots: ObjectId[]): Promise<Map<ObjectId, ObjectRef>> {
    const result = new Map<ObjectId, ObjectRef>();
    const pending = [...roots];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (result.has(id)) continue;
      let found: ObjectRef | undefined;
      for await (const reference of this.store.list()) {
        if (reference.id === id) {
          found = reference;
          break;
        }
      }
      if (!found) throw new EngineSpecError("STORE_OBJECT_NOT_FOUND", `Reachable object not found: ${id}`);
      result.set(id, found);
      const payload = (await this.store.get(found)).payload as Record<string, unknown>;
      if (found.kind === "commit") {
        const commit = payload as unknown as CommitPayload;
        pending.push(commit.snapshotId, ...commit.parents, ...commit.provenanceRefs);
      } else if (found.kind === "snapshot") {
        pending.push(...(payload as unknown as SnapshotPayload).provenanceRefs);
      } else if (found.kind === "provenance") {
        const inputs = (payload as unknown as ProvenancePayload).inputs;
        pending.push(...inputs.map((ref) => ref.id));
      }
    }
    return result;
  }

  private async reachableContents(objects: Map<ObjectId, ObjectRef>): Promise<ContentRef[]> {
    const addresses = new Map<string, ContentRef>();
    for (const reference of objects.values()) {
      if (reference.kind !== "snapshot") continue;
      const payload = (await this.store.get(reference)).payload as unknown as SnapshotPayload;
      for (const entry of payload.entries) {
        for (const content of entry.contentRefs) {
          addresses.set(`${content.address.algorithm}:${content.address.digest}`, content);
        }
      }
    }
    return [...addresses.values()];
  }

  private async contentMaterialize(address: ContentRef["address"], destination: string): Promise<void> {
    const handle = await open(destination, "wx");
    try {
      await this.content.copyTo(address, {
        async write(chunk: Uint8Array): Promise<void> {
          await handle.write(chunk);
        },
      });
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function defaultAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new FilesystemAdapter());
  registry.register(new StructuredAdapter());
  return registry;
}

function indexEntries(entries: SnapshotEntry[]): Map<string, SnapshotEntry> {
  return new Map(entries.map((entry) => [entry.resource.resourceId, entry]));
}

function groupByAdapter(entries: SnapshotEntry[]): Map<string, SnapshotEntry[]> {
  const result = new Map<string, SnapshotEntry[]>();
  for (const entry of entries) {
    const list = result.get(entry.resource.adapterId) ?? [];
    list.push(entry);
    result.set(entry.resource.adapterId, list);
  }
  return result;
}

function validateCommitInput(input: CommitInput): void {
  if (!input.message.trim()) throw new EngineSpecError("CORE_INVALID_MESSAGE", "Commit message is required");
  if (!input.author.id.trim()) throw new EngineSpecError("CORE_INVALID_AUTHOR", "Commit author is required");
  if (!isHeadName(input.ref)) throw new EngineSpecError("CORE_INVALID_REF", "Commits require a heads ref");
  if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new EngineSpecError("CORE_INVALID_GENERATION", "Expected generation must be a non-negative integer");
  }
}

function staleRef(name: Ref["name"], expected: ObjectId | null, observed: ObjectId | null): EngineSpecError {
  return new EngineSpecError("STORE_STALE_REF", `Ref changed: ${name}`, true, {
    expected,
    observed,
  });
}

function normalizeHeadName(value: string): Ref["name"] {
  const name = value.replace(/^refs\//, "").replace(/^heads\//, "");
  if (!name || name.includes("\0")) throw new EngineSpecError("CORE_INVALID_REF", "Invalid branch name");
  return `heads/${name}`;
}

function normalizeTagName(value: string): Ref["name"] {
  const name = value.replace(/^refs\//, "").replace(/^tags\//, "");
  if (!name || name.includes("\0")) throw new EngineSpecError("CORE_INVALID_REF", "Invalid tag name");
  return `tags/${name}`;
}

function isHeadName(value: string): value is Ref["name"] {
  return value.startsWith("heads/") && value.length > "heads/".length;
}

function locatorPath(locator: StoreLocator): string {
  if (locator.scheme !== "file") {
    throw new EngineSpecError("STORE_LOCATOR_UNSUPPORTED", `Unsupported locator: ${locator.scheme}`);
  }
  return path.resolve(locator.value);
}

function assertUniqueResources(entries: SnapshotEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.resource.resourceId)) {
      throw new EngineSpecError(
        "SNAPSHOT_DUPLICATE_RESOURCE",
        `Duplicate resource: ${entry.resource.resourceId}`,
      );
    }
    if (entry.state === "deleted" && (entry.contentRefs.length > 0 || entry.structuredState)) {
      throw new EngineSpecError(
        "SNAPSHOT_INVALID_DELETION",
        `Deleted resource cannot contain state: ${entry.resource.resourceId}`,
      );
    }
    seen.add(entry.resource.resourceId);
  }
}

function issue(
  severity: Issue["severity"],
  code: string,
  message: string,
  object?: string,
): Issue {
  return { severity, code, message, ...(object ? { object } : {}) };
}

async function writeBinding(root: string, binding: WorkspaceBinding): Promise<void> {
  const directory = path.join(root, ".enginespec");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "workspace.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function readBinding(root: string): Promise<WorkspaceBinding> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(root, ".enginespec", "workspace.json"), "utf8"));
  } catch (cause) {
    throw new EngineSpecError(
      "WORKSPACE_BINDING_NOT_FOUND",
      "Workspace binding is missing or invalid",
      false,
      undefined,
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null ||
      (parsed as Record<string, unknown>).format !== "enginespec-workspace" ||
      (parsed as Record<string, unknown>).formatVersion !== "2.0") {
    throw new EngineSpecError("WORKSPACE_BINDING_INVALID", "Invalid workspace binding");
  }
  return parsed as WorkspaceBinding;
}

async function readManifest(root: string): Promise<{ projectId: string }> {
  const parsed = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as
    { projectId?: unknown };
  if (typeof parsed.projectId !== "string") {
    throw new EngineSpecError("STORE_CORRUPT_OBJECT", "Trace Store manifest has no project ID");
  }

  return { projectId: parsed.projectId };
}

interface BundleManifest {
  format: "enginespec-bundle";
  formatVersion: "1";
  projectId: string;
  objects: ObjectRef[];
  contents: ContentRef[];
  refs: Ref[];
}

async function readBundleManifest(root: string): Promise<BundleManifest> {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as
    BundleManifest;
  if (manifest.format !== "enginespec-bundle" || manifest.formatVersion !== "1") {
    throw new EngineSpecError("BUNDLE_FORMAT_UNSUPPORTED", "Unsupported EngineSpec bundle");
  }
  return manifest;
}

