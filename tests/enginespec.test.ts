import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AISpecEngine,
  EngineSpecEngine,
  EngineSpecError,
  LocalSignatureProvider,
  canonicalJson,
  generateEngineSpecKeyPair,
  migrateAISpecV0,
  parseObjectId,
} from "../src/index.js";

describe("EngineSpec v2", () => {
  it("produces stable canonical IDs and rejects invalid IDs", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 1 } }))
      .toBe('{"a":{"x":1,"y":2},"z":1}');
    expect(() => parseObjectId("sha256:bad")).toThrow(EngineSpecError);
  });

  it("stores structured state outside the workspace and commits to CAS refs", async () => {
    const root = await createFixture();
    try {
      const engine = await EngineSpecEngine.initialize({
        name: "Structured project",
        workspace: root.workspace,
        traceStore: { scheme: "file", value: root.trace },
      });
      const snapshot = await engine.capture({
        adapterId: "enginespec.structured",
        selectors: [{
          type: "structured.json",
          locator: { resourceId: "settings", state: { enabled: true, limit: 4 } },
        }],
      });
      const first = await engine.commit({
        snapshotId: snapshot.id,
        ref: "heads/main",
        expectedHead: null,
        expectedGeneration: 0,
        author: { id: "local:developer" },
        message: "Initial state",
      });

      expect(first.ref).toMatchObject({
        name: "heads/main",
        target: first.commit.id,
        generation: 1,
      });
      const reopened = await EngineSpecEngine.open({ workspace: root.workspace });
      expect((await reopened.getRef("heads/main"))?.target).toBe(first.commit.id);
      expect((await reopened.get(snapshot))).toMatchObject({
        projectId: engine.workspace.projectId,
        entries: [{
          resource: { resourceId: "settings", type: "structured.json" },
        }],
      });
    } finally {
      await root.cleanup();
    }
  });

  it("deduplicates filesystem blobs and restores them", async () => {
    const root = await createFixture();
    try {
      const engine = await EngineSpecEngine.initialize({
        name: "Files",
        workspace: root.workspace,
        traceStore: { scheme: "file", value: root.trace },
      });
      const source = path.join(root.workspace, "data.txt");
      await writeFile(source, "same bytes\n", "utf8");
      const first = await engine.capture({
        selectors: [{ type: "filesystem.file", locator: { path: "data.txt" } }],
      });
      const second = await engine.capture({
        selectors: [{ type: "filesystem.file", locator: { path: "data.txt" } }],
      });
      const firstPayload = await engine.get(first);
      const secondPayload = await engine.get(second);
      expect(firstPayload.entries[0]!.contentRefs).toEqual(
        secondPayload.entries[0]!.contentRefs,
      );

      const destination = path.join(root.parent, "restore");
      const restored = await engine.restore({
        snapshotId: first.id,
        mode: "materialize",
        target: { locator: { path: destination } },
      });
      expect(restored.restored).toEqual(["filesystem:data.txt"]);
      expect(await readFile(path.join(destination, "data.txt"), "utf8")).toBe("same bytes\n");
    } finally {
      await root.cleanup();
    }
  });

  it("rejects stale ref updates instead of losing a concurrent commit", async () => {
    const root = await createFixture();
    try {
      const left = await EngineSpecEngine.initialize({
        name: "Concurrent",
        workspace: root.workspace,
        traceStore: { scheme: "file", value: root.trace },
      });
      const right = await EngineSpecEngine.open({ workspace: root.workspace });
      const snapshot = await left.capture({
        selectors: [{
          type: "structured.json",
          locator: { resourceId: "state", state: { value: 1 } },
        }],
      });
      const initial = await left.commit({
        snapshotId: snapshot.id,
        ref: "heads/main",
        expectedHead: null,
        expectedGeneration: 0,
        author: { id: "local:a" },
        message: "Initial",
      });
      const updates = await Promise.allSettled([
        left.commit({
          snapshotId: snapshot.id,
          ref: "heads/main",
          expectedHead: initial.commit.id,
          expectedGeneration: initial.ref.generation,
          author: { id: "local:a" },
          message: "Left",
        }),
        right.commit({
          snapshotId: snapshot.id,
          ref: "heads/main",
          expectedHead: initial.commit.id,
          expectedGeneration: initial.ref.generation,
          author: { id: "local:b" },
          message: "Right",
        }),
      ]);
      expect(updates.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      const rejected = updates.find((item) => item.status === "rejected");
      expect(rejected && rejected.reason).toMatchObject({ code: "STORE_STALE_REF" });
    } finally {
      await root.cleanup();
    }
  });

  it("merges independent resource changes and reports real conflicts", async () => {
    const root = await createFixture();
    try {
      const engine = await EngineSpecEngine.initialize({
        name: "Merge",
        workspace: root.workspace,
        traceStore: { scheme: "file", value: root.trace },
      });
      const base = await engine.capture({
        selectors: [{
          type: "structured.json",
          locator: { resourceId: "config", state: { value: 0 } },
        }],
      });
      const initial = await engine.commit({
        snapshotId: base.id,
        ref: "heads/main",
        expectedHead: null,
        expectedGeneration: 0,
        author: { id: "local:a" },
        message: "Base",
      });
      const featureRef = await engine.branch({ name: "feature", from: initial.commit.id });
      const changed = await engine.capture({
        selectors: [{
          type: "structured.json",
          locator: { resourceId: "config", state: { value: 2 } },
        }],
      });
      await engine.commit({
        snapshotId: changed.id,
        ref: "heads/feature",
        expectedHead: featureRef.target,
        expectedGeneration: featureRef.generation,
        author: { id: "local:b" },
        message: "Feature change",
      });
      const source = (await engine.getRef("heads/feature"))!;
      const clean = await engine.merge({
        sourceCommitId: source.target,
        targetRef: "heads/main",
        expectedTargetHead: initial.commit.id,
        expectedTargetGeneration: initial.ref.generation,
        author: { id: "local:a" },
        message: "Merge feature",
      });
      expect(clean.status).toBe("merged");
      if (clean.status !== "merged") return;

      const otherBranch = await engine.branch({ name: "other", from: clean.commit.id });
      const oursSnapshot = await engine.capture({
        selectors: [{
          type: "structured.json",
          locator: { resourceId: "config", state: { value: 3 } },
        }],
      });
      const ours = await engine.commit({
        snapshotId: oursSnapshot.id,
        ref: "heads/main",
        expectedHead: clean.commit.id,
        expectedGeneration: clean.ref.generation,
        author: { id: "local:a" },
        message: "Main change",
      });
      const theirsSnapshot = await engine.capture({
        selectors: [{
          type: "structured.json",
          locator: { resourceId: "config", state: { value: 4 } },
        }],
      });
      await engine.commit({
        snapshotId: theirsSnapshot.id,
        ref: "heads/other",
        expectedHead: otherBranch.target,
        expectedGeneration: otherBranch.generation,
        author: { id: "local:b" },
        message: "Other change",
      });
      const theirHead = (await engine.getRef("heads/other"))!;
      const conflict = await engine.merge({
        sourceCommitId: theirHead.target,
        targetRef: "heads/main",
        expectedTargetHead: ours.commit.id,
        expectedTargetGeneration: ours.ref.generation,
        author: { id: "local:a" },
        message: "Conflicting merge",
      });
      expect(conflict.status).toBe("conflicts");
    } finally {
      await root.cleanup();
    }
  });

  it("stores and verifies detached EngineSpec signatures", async () => {
    const root = await createFixture();
    try {
      const engine = await EngineSpecEngine.initialize({
        name: "Signed",
        workspace: root.workspace,
        traceStore: { scheme: "file", value: root.trace },
      });
      const passphrase = "a strong test passphrase";
      const keys = generateEngineSpecKeyPair(passphrase);
      engine.registerSigner(new LocalSignatureProvider(
        "local-test",
        keys.encryptedPrivateKey,
        passphrase,
      ));
      const snapshot = await engine.capture({
        selectors: [{
          type: "structured.json",
          locator: { resourceId: "state", state: { signed: true } },
        }],
      });
      const result = await engine.commit({
        snapshotId: snapshot.id,
        ref: "heads/main",
        expectedHead: null,
        expectedGeneration: 0,
        author: { id: "local:alice", displayName: "Alice" },
        message: "Signed state",
        signerId: "local-test",
      });
      const verification = await engine.verify(result.commit);
      expect(verification.valid).toBe(true);
      expect(verification.signatures).toMatchObject([
        { cryptographic: "valid", trust: "unknown" },
      ]);
    } finally {
      await root.cleanup();
    }
  });

  it("exports and imports verified bundles without moving local refs implicitly", async () => {
    const root = await createFixture();
    try {
      const engine = await EngineSpecEngine.initialize({
        name: "Bundle source",
        workspace: root.workspace,
        traceStore: { scheme: "file", value: root.trace },
      });
      const snapshot = await engine.capture({
        selectors: [{
          type: "structured.json",
          locator: { resourceId: "bundle-state", state: { value: 1 } },
        }],
      });
      const commit = await engine.commit({
        snapshotId: snapshot.id,
        ref: "heads/main",
        expectedHead: null,
        expectedGeneration: 0,
        author: { id: "local:a" },
        message: "Bundle state",
      });
      const bundlePath = path.join(root.parent, "bundle");
      const exported = await engine.exportBundle({
        destination: bundlePath,
        refs: ["heads/main"],
      });
      expect(exported.refs[0]?.target).toBe(commit.commit.id);

      const targetTrace = path.join(root.parent, "target-trace");
      const targetWorkspace = path.join(root.parent, "target-workspace");
      const target = await EngineSpecEngine.initialize({
        name: "Bundle target",
        workspace: targetWorkspace,
        traceStore: { scheme: "file", value: targetTrace },
        projectId: engine.workspace.projectId,
      });
      const imported = await target.importBundle({ bundle: bundlePath });
      expect(imported).toMatchObject({
        objects: expect.any(Number),
        contents: expect.any(Number),
        refs: [],
      });
      expect(await target.getRef("heads/main")).toBeNull();
      expect((await target.listObjects("commit")).some((ref) => ref.id === commit.commit.id))
        .toBe(true);
      const withRef = await target.importBundle({
        bundle: bundlePath,
        refs: [{
          source: "heads/main",
          target: "heads/main",
          expectedTargetHead: null,
          expectedTargetGeneration: 0,
        }],
      });
      expect(withRef.refs[0]?.target).toBe(commit.commit.id);
    } finally {
      await root.cleanup();
    }
  });

  it("migrates AISpec v0 without changing the original repository", async () => {
    const root = await createFixture();
    try {
      const source = path.join(root.parent, "legacy");
      const legacy = AISpecEngine.create(source, { name: "Legacy" });
      legacy.addNode({ id: "legacy-node" });
      const snapshot = legacy.createSnapshot({
        nodeId: "legacy-node",
        configuration: { prompt: "legacy" },
      });
      const commit = legacy.createCommit({
        author: "legacy author",
        message: "Legacy commit",
        snapshotIds: [snapshot.id],
      });
      const manifestBefore = await readFile(path.join(source, "aispec.yaml"), "utf8");
      const dryRun = await migrateAISpecV0({
        source,
        workspace: path.join(root.parent, "migration-workspace"),
        traceStore: { scheme: "file", value: path.join(root.parent, "migration-trace") },
        dryRun: true,
      });
      expect(dryRun.commitMappings).toEqual([]);
      expect(await readFile(path.join(source, "aispec.yaml"), "utf8")).toBe(manifestBefore);

      const migrated = await migrateAISpecV0({
        source,
        workspace: root.workspace,
        traceStore: { scheme: "file", value: root.trace },
      });
      expect(migrated.commitMappings.map((item) => item.legacyId)).toContain(commit.id);
      const engine = await EngineSpecEngine.open({ workspace: root.workspace });
      const main = await engine.getRef("heads/main");
      expect(main).not.toBeNull();
      expect(await engine.verify({ kind: "commit", id: main!.target })).toMatchObject({
        valid: true,
      });
      expect(await readFile(path.join(source, "aispec.yaml"), "utf8")).toBe(manifestBefore);
    } finally {
      await root.cleanup();
    }
  });
});

async function createFixture(): Promise<{
  parent: string;
  workspace: string;
  trace: string;
  cleanup(): Promise<void>;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "enginespec-test-"));
  return {
    parent,
    workspace: path.join(parent, "workspace"),
    trace: path.join(parent, "trace"),
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

