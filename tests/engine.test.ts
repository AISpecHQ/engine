import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AISpecEngine } from "../src/engine.js";
import { RepositoryStorage } from "../src/storage.js";

describe("AISpecEngine repository foundation", () => {
  it("creates and reopens a repository with its canonical layout", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    const root = path.join(parent, "project");
    try {
      const engine = AISpecEngine.create(root, {
        name: "Test Project",
        author: "Test",
      });
      const reopened = AISpecEngine.open(root);

      expect(reopened.manifest).toEqual(engine.manifest);
      expect(reopened.manifest.name).toBe("Test Project");
      expect(reopened.listBranches()).toHaveLength(1);
      expect(reopened.listBranches()[0]?.name).toBe("main");
      expect(reopened.validate().valid).toBe(true);

      const entries = await readdir(root);
      for (const directory of [
        "nodes", "flows", "branches", "commits", "snapshots", "evaluations",
        "environments", "policies", "connectors", "artifacts", "extensions",
        ".aispec",
      ]) {
        expect(entries).toContain(directory);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("saves idempotently and preserves repository state across reopening", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Save Repository Test" });
      const node = engine.addNode({ id: "saved-node" });
      const snapshot = engine.createSnapshot({
        nodeId: node.id,
        configuration: { persisted: true },
      });
      const commit = engine.createCommit({
        message: "Save repository test",
        author: "Test",
        snapshotIds: [snapshot.id],
      });
      const manifestBefore = await readFile(path.join(root, "aispec.yaml"), "utf8");

      expect(engine.saveRepository()).toBeUndefined();
      expect(engine.saveRepository()).toBeUndefined();
      expect(await readFile(path.join(root, "aispec.yaml"), "utf8")).toBe(manifestBefore);

      const reopened = AISpecEngine.open(root);
      expect(reopened.getNode(node.id)).toEqual(node);
      expect(reopened.getSnapshot(snapshot.id)).toEqual(snapshot);
      expect(reopened.getCommit(commit.id)).toEqual(commit);
      expect(reopened.getStateAtCommit(commit.id).get(node.id)).toEqual(snapshot);
      expect(reopened.getBranch("main")?.head).toBe(commit.id);
      expect(reopened.validate().valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves merged and restored history without losing branch state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Save Merged History Test" });
      const node = engine.addNode({ id: "merged-history-node" });
      const snapshot = engine.createSnapshot({
        nodeId: node.id,
        configuration: { original: true },
      });
      const mainCommit = engine.createCommit({
        message: "Create original state",
        author: "Test",
        snapshotIds: [snapshot.id],
      });
      const feature = engine.createBranch({ name: "feature", author: "Test" });
      const featureCommit = engine.createCommit({
        branch: feature.name,
        message: "Feature commit",
        author: "Test",
      });
      const mergeCommit = engine.mergeBranches("feature", "main", "Test", "Merge feature");
      const restored = engine.restoreSnapshot(snapshot.id, {
        author: "Test",
        message: "Restore original state",
      });

      engine.saveRepository();

      const reopened = AISpecEngine.open(root);
      expect(reopened.getBranch("feature")?.head).toBe(featureCommit.id);
      expect(reopened.getBranch("main")?.head).toBe(restored.commit.id);
      expect(reopened.getCommit(mergeCommit.id)?.parents).toEqual([
        mainCommit.id,
        featureCommit.id,
      ]);
      expect(reopened.getStateAtCommit(restored.commit.id).get(node.id))
        .toEqual(restored.snapshot);
      expect(reopened.validate().valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists commits in timestamp and id order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Commit Listing Test" });
      const storage = new RepositoryStorage(root);
      const initialCommit = engine.listCommits()[0]!;
      const now = Date.now();
      for (const [id, timestamp] of [
        ["c-late", new Date(now + 60_000).toISOString()],
        ["c-early", new Date(now - 60_000).toISOString()],
      ]) {
        storage.write(storage.pathFor("commits", id), {
          id,
          parents: [],
          branch: "main",
          author: "Test",
          timestamp,
          message: id,
          snapshotIds: [],
          tags: [],
          metadata: {},
        });
      }

      expect(engine.listCommits().map((commit) => commit.id)).toEqual([
        "c-early",
        initialCommit.id,
        "c-late",
      ]);

      expect(engine.listCommits()).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists snapshots by node and version and filters by node id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Snapshot Listing Test" });
      engine.addNode({ id: "node-z" });
      engine.addNode({ id: "node-a" });
      const z1 = engine.createSnapshot({ nodeId: "node-z", configuration: { version: 1 } });
      const a1 = engine.createSnapshot({ nodeId: "node-a", configuration: { version: 1 } });
      const a2 = engine.createSnapshot({ nodeId: "node-a", configuration: { version: 2 } });
      const z2 = engine.createSnapshot({ nodeId: "node-z", configuration: { version: 2 } });

      expect(engine.listSnapshots()).toEqual([a1, a2, z1, z2]);
      expect(engine.listSnapshots("node-a")).toEqual([a1, a2]);
      expect(engine.listSnapshots("missing-node")).toEqual([]);
      expect(engine.listSnapshots()).toEqual([a1, a2, z1, z2]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists branches by name and returns an empty list when none exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Branch Listing Test" });
      engine.createBranch({ name: "zeta", author: "Test" });
      engine.createBranch({ name: "alpha", author: "Test" });

      expect(engine.listBranches().map((branch) => branch.name)).toEqual([
        "alpha",
        "main",
        "zeta",
      ]);

      const storage = new RepositoryStorage(root);
      for (const branch of engine.listBranches()) {
        storage.remove(storage.pathFor("branches", branch.id));
      }
      expect(engine.listBranches()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["aispec.yaml", "commits/", "branches/"])(
    "cleans up only its own files and allows retry after %s initialization failure",
    async (failedPath) => {
      const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
      const preservedPath = path.join(root, "user-data.txt");
      const originalWrite = RepositoryStorage.prototype.write;
      try {
        await writeFile(preservedPath, "preserve this file");
        vi.spyOn(RepositoryStorage.prototype, "write").mockImplementation(
          function (relativePath, value, replace) {
            const normalizedPath = relativePath.replaceAll("\\", "/");
            if (
              (failedPath === "aispec.yaml" && normalizedPath === failedPath) ||
              (failedPath !== "aispec.yaml" && normalizedPath.startsWith(failedPath))
            ) {
              throw new Error(`Simulated ${failedPath} write failure`);
            }
            return originalWrite.call(this, relativePath, value, replace);
          },
        );

        expect(() => AISpecEngine.create(root, { name: "Failed initialization" }))
          .toThrow(`Simulated ${failedPath} write failure`);
        vi.restoreAllMocks();

        expect(await readFile(preservedPath, "utf8")).toBe("preserve this file");
        expect(await readdir(path.join(root, "commits"))).toEqual([]);
        expect(await readdir(path.join(root, "branches"))).toEqual([]);
        await expect(readFile(path.join(root, "aispec.yaml"))).rejects.toMatchObject({
          code: "ENOENT",
        });

        const engine = AISpecEngine.create(root, { name: "Successful retry" });
        expect(engine.manifest.name).toBe("Successful retry");
        expect(engine.validate().valid).toBe(true);
        expect(await readFile(preservedPath, "utf8")).toBe("preserve this file");
      } finally {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not modify an existing manifest when repository creation is rejected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    const manifestPath = path.join(root, "aispec.yaml");
    try {
      await writeFile(manifestPath, "existing repository data");

      expect(() => AISpecEngine.create(root, { name: "Replacement" }))
        .toThrow("AISpec repository already exists");
      expect(await readFile(manifestPath, "utf8")).toBe("existing repository data");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists nodes and snapshots as readable YAML across reopen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Persistence Test" });
      engine.addNode({ id: "agent", type: "agent", label: "Assistant" });
      const snapshot = engine.createSnapshot({
        nodeId: "agent",
        configuration: { model: "example-model", temperature: 0.2 },
        capabilities: ["text-generation"],
      });

      const reopened = AISpecEngine.open(root);
      expect(reopened.getNode("agent")).toEqual({
        id: "agent",
        type: "agent",
        label: "Assistant",
      });
      expect(reopened.getSnapshot(snapshot.id)).toEqual(snapshot);
      expect(reopened.validate().valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds objects by id when filenames do not encode their ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Filename Compatibility Test" });
      const storage = new RepositoryStorage(root);
      const now = new Date().toISOString();
      const node = { id: "external-node", type: "agent" };
      const snapshot = {
        id: "external-snapshot",
        nodeId: node.id,
        version: 1,
        createdAt: now,
        configuration: { prompt: "external" },
        capabilities: [],
        connectors: [],
        artifacts: [],
        metadata: {},
      };
      const initialCommit = engine.getBranch("main")!.head;
      const commit = {
        id: "external-commit",
        parents: [initialCommit],
        branch: "main",
        author: "Test",
        timestamp: now,
        message: "External filename fixture",
        snapshotIds: [snapshot.id],
        tags: [],
        metadata: {},
      };
      const branch = {
        id: "external-branch",
        name: "feature/external",
        parent: "main",
        head: commit.id,
        createdAt: now,
        author: "Test",
        tags: [],
        metadata: {},
      };
      storage.write("nodes/external-node.yaml", node);
      storage.write("snapshots/external-snapshot.yaml", snapshot);
      storage.write("commits/external-commit.yaml", commit);
      storage.write("branches/external-branch.yaml", branch);

      const reopened = AISpecEngine.open(root);
      expect(reopened.getNode(node.id)).toEqual(node);
      expect(reopened.getSnapshot(snapshot.id)).toEqual(snapshot);
      expect(reopened.getCommit(commit.id)).toEqual(commit);
      expect(reopened.getBranch(branch.id)).toEqual(branch);
      expect(reopened.getBranch(branch.name)).toEqual(branch);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing repository or node", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Immutable Test" });
      engine.addNode({ id: "agent", type: "agent" });

      expect(() => AISpecEngine.create(root, { name: "Replacement" })).toThrow(
        "already exists",
      );
      expect(() => engine.addNode({ id: "agent", type: "different" })).toThrow(
        "Node already exists",
      );
      expect(engine.getNode("agent")?.type).toBe("agent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["snapshots", "commits"] as const)(
    "rejects a node ID already used by a %s object without changing repository state",
    async (directory) => {
      const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
      try {
        const engine = AISpecEngine.create(root, { name: "Node ID Collision Test" });
        const storage = new RepositoryStorage(root);
        const branchHead = engine.getBranch("main")!.head;
        const existingNodeIds = engine.listNodes().map((node) => node.id);
        storage.write(`${directory}/collision.yaml`, { id: "cross-type-id" });

        expect(() => engine.addNode({ id: "cross-type-id" }))
          .toThrow(/ID.*already used|already used.*ID/i);

        expect(engine.listNodes().map((node) => node.id)).toEqual(existingNodeIds);
        expect(engine.getBranch("main")?.head).toBe(branchHead);
        expect(engine.validate().issues.some((issue) =>
          issue.code === "DUPLICATE_ID",
        )).toBe(false);
        expect(storage.list("nodes")).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects node creation when an extension ID cannot be inspected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Unreadable Extension Guard" });
      await writeFile(path.join(root, "extensions", "broken.yaml"), "id: [unterminated");
      const branchHead = engine.getBranch("main")!.head;

      expect(() => engine.addNode({ id: "candidate-node" }))
        .toThrow(/extension.*inspect|inspect.*extension/i);

      expect(engine.getNode("candidate-node")).toBeUndefined();
      expect(engine.getBranch("main")?.head).toBe(branchHead);
      expect(await readFile(path.join(root, "extensions", "broken.yaml"), "utf8"))
        .toBe("id: [unterminated");

      const storage = (engine as any).storage as RepositoryStorage;
      const originalList = storage.list;
      vi.spyOn(storage, "list").mockImplementation((directory) => {
        if (directory === "extensions") throw new Error("Simulated extension listing failure");
        return originalList.call(storage, directory);
      });
      expect(() => engine.addNode({ id: "candidate-after-list-failure" }))
        .toThrow(/Cannot verify unique ID .* could not list extensions/);
      expect(engine.getNode("candidate-after-list-failure")).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["connectors", "artifacts"] as const)(
    "does not persist a snapshot with a missing %s reference",
    async (directory) => {
      const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
      try {
        const engine = AISpecEngine.create(root, { name: "Snapshot Reference Test" });
        engine.addNode({ id: "agent" });
        const previousSnapshots = engine.listSnapshots();

        expect(() => engine.createSnapshot({
          nodeId: "agent",
          configuration: {},
          [directory]: [`missing-${directory}`],
        })).toThrow(new RegExp(`${directory.slice(0, -1)}.*not found`, "i"));

        expect(engine.listSnapshots()).toEqual(previousSnapshots);
        expect(engine.validate().issues.some((issue) =>
          issue.code === "MISSING_CONNECTOR" || issue.code === "MISSING_ARTIFACT",
        )).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("creates snapshots when referenced connector and artifact documents exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Snapshot References Present" });
      const storage = new RepositoryStorage(root);
      engine.addNode({ id: "agent" });
      storage.write("connectors/connector-1.yaml", { id: "connector-1" });
      storage.write("artifacts/artifact-1.yaml", { id: "artifact-1" });

      const snapshot = engine.createSnapshot({
        nodeId: "agent",
        configuration: {},
        connectors: ["connector-1"],
        artifacts: ["artifact-1"],
      });

      expect(engine.getSnapshot(snapshot.id)).toEqual(snapshot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records snapshots in commits and advances branch heads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "History Test" });
      engine.addNode({ id: "agent", type: "agent" });
      const snapshot = engine.createSnapshot({
        nodeId: "agent",
        configuration: { prompt: "original" },
      });
      const commit = engine.createCommit({
        message: "Add agent configuration",
        author: "Test",
        snapshotIds: [snapshot.id],
      });

      expect(engine.getBranch("main")?.head).toBe(commit.id);
      expect(engine.getStateAtCommit(commit.id).get("agent")).toEqual(snapshot);
      expect(engine.validate().valid).toBe(true);
      expect(AISpecEngine.open(root).getCommit(commit.id)).toEqual(commit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a newly written commit if advancing the branch head fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Commit Rollback Test" });
      const storage = (engine as any).storage as RepositoryStorage;
      const branch = engine.getBranch("main")!;
      const branchPath = storage.pathFor("branches", branch.id);
      const write = vi.spyOn(storage, "write").mockImplementation(
        (relativePath, value, replace) => {
          if (relativePath === branchPath && replace) {
            throw new Error("Simulated branch head write failure");
          }
          return RepositoryStorage.prototype.write.call(storage, relativePath, value, replace);
        },
      );

      try {
        expect(() =>
          engine.createCommit({ message: "Will not be committed", author: "Test" }),
        ).toThrow("Simulated branch head write failure");
      } finally {
        write.mockRestore();
      }

      expect(engine.listCommits()).toHaveLength(1);
      expect(engine.getBranch("main")?.head).toBe(branch.head);
      expect(engine.validate().valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the restored snapshot if committing the restore fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Restore Rollback Test" });
      engine.addNode({ id: "agent" });
      const original = engine.createSnapshot({
        nodeId: "agent",
        configuration: { prompt: "original" },
      });
      engine.createCommit({
        message: "Original state",
        author: "Test",
        snapshotIds: [original.id],
      });
      const branch = engine.getBranch("main")!;
      const storage = (engine as any).storage as RepositoryStorage;
      const branchPath = storage.pathFor("branches", branch.id);
      const write = vi.spyOn(storage, "write").mockImplementation(
        (relativePath, value, replace) => {
          if (relativePath === branchPath && replace) {
            throw new Error("Simulated branch head write failure");
          }
          return RepositoryStorage.prototype.write.call(storage, relativePath, value, replace);
        },
      );

      try {
        expect(() => engine.restoreSnapshot(original.id, { author: "Test" }))
          .toThrow("Simulated branch head write failure");
      } finally {
        write.mockRestore();
      }

      expect(engine.listSnapshots()).toEqual([original]);
      expect(engine.listCommits()).toHaveLength(2);
      expect(engine.getBranch("main")?.head).toBe(branch.head);
      expect(engine.validate().valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates branches and merges histories without rewriting commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Branch Test" });
      const base = engine.getBranch("main")!;
      const feature = engine.createBranch({
        name: "feature/example",
        author: "Test",
      });
      const featureCommit = engine.createCommit({
        branch: feature.name,
        message: "Feature work",
        author: "Test",
      });
      const merge = engine.mergeBranches(
        feature.name,
        "main",
        "Test",
        "Merge feature",
      );

      expect(feature.parent).toBe("main");
      expect(featureCommit.parents).toEqual([base.head]);
      expect(merge.parents).toEqual([base.head, featureCommit.id]);
      expect(engine.getBranch("main")?.head).toBe(merge.id);
      expect(engine.getCommit(featureCommit.id)).toEqual(featureCommit);
      expect(engine.validate().valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes changes to different nodes from both merged histories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Merge State Test" });
      engine.addNode({ id: "main-agent" });
      engine.addNode({ id: "feature-agent" });
      const feature = engine.createBranch({
        name: "feature/state",
        author: "Test",
      });

      const mainSnapshot = engine.createSnapshot({
        nodeId: "main-agent",
        configuration: { prompt: "main change" },
      });
      engine.createCommit({
        message: "Change main agent",
        author: "Test",
        snapshotIds: [mainSnapshot.id],
      });
      const featureSnapshot = engine.createSnapshot({
        nodeId: "feature-agent",
        configuration: { prompt: "feature change" },
      });
      engine.createCommit({
        branch: feature.name,
        message: "Change feature agent",
        author: "Test",
        snapshotIds: [featureSnapshot.id],
      });

      const merge = engine.mergeBranches(
        feature.name,
        "main",
        "Test",
        "Merge node changes",
      );
      const state = engine.getStateAtCommit(merge.id);

      expect(state.get("main-agent")).toEqual(mainSnapshot);
      expect(state.get("feature-agent")).toEqual(featureSnapshot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the target branch's first-parent snapshot when both branches change one node", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Merge Conflict Test" });
      engine.addNode({ id: "agent" });
      const base = engine.createSnapshot({
        nodeId: "agent",
        configuration: { prompt: "base" },
      });
      engine.createCommit({
        message: "Add base agent",
        author: "Test",
        snapshotIds: [base.id],
      });
      const feature = engine.createBranch({
        name: "feature/conflict",
        author: "Test",
      });

      const targetSnapshot = engine.createSnapshot({
        nodeId: "agent",
        configuration: { prompt: "target change" },
      });
      const targetCommit = engine.createCommit({
        message: "Change target branch",
        author: "Test",
        snapshotIds: [targetSnapshot.id],
      });
      const sourceSnapshot = engine.createSnapshot({
        nodeId: "agent",
        configuration: { prompt: "source change" },
      });
      engine.createCommit({
        branch: feature.name,
        message: "Change source branch",
        author: "Test",
        snapshotIds: [sourceSnapshot.id],
      });

      const merge = engine.mergeBranches(
        feature.name,
        "main",
        "Test",
        "Merge conflicting changes",
      );

      expect(merge.parents[0]).toBe(targetCommit.id);
      expect(engine.getStateAtCommit(merge.id).get("agent")).toEqual(targetSnapshot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reopens a repository and reconstructs merged state from both parents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Reopened Merge Test" });
      engine.addNode({ id: "main-agent" });
      engine.addNode({ id: "feature-agent" });
      const feature = engine.createBranch({
        name: "feature/reopen",
        author: "Test",
      });

      const mainSnapshot = engine.createSnapshot({
        nodeId: "main-agent",
        configuration: { prompt: "main change" },
      });
      engine.createCommit({
        message: "Change main agent",
        author: "Test",
        snapshotIds: [mainSnapshot.id],
      });
      const featureSnapshot = engine.createSnapshot({
        nodeId: "feature-agent",
        configuration: { prompt: "feature change" },
      });
      engine.createCommit({
        branch: feature.name,
        message: "Change feature agent",
        author: "Test",
        snapshotIds: [featureSnapshot.id],
      });
      const merge = engine.mergeBranches(
        feature.name,
        "main",
        "Test",
        "Merge node changes",
      );

      const reopened = AISpecEngine.open(root);
      const state = reopened.getStateAtCommit(merge.id);
      expect(reopened.getBranch("main")?.head).toBe(merge.id);
      expect(state.get("main-agent")).toEqual(mainSnapshot);
      expect(state.get("feature-agent")).toEqual(featureSnapshot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reconstruction when a required parent commit is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Missing Parent Reconstruction" });
      const commit = {
        id: "c_missing_parent_child",
        parents: ["c_missing_parent"],
        branch: "main",
        author: "Test",
        timestamp: "2025-01-01T00:00:00Z",
        message: "Missing parent",
        snapshotIds: [],
        tags: [],
        metadata: {},
      };
      new RepositoryStorage(root).write("commits/missing-parent-child.yaml", commit);

      expect(() => engine.getStateAtCommit(commit.id))
        .toThrow("Commit not found: c_missing_parent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reconstruction when a referenced snapshot is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Missing Snapshot Reconstruction" });
      const commit = {
        id: "c_missing_snapshot",
        parents: [],
        branch: "main",
        author: "Test",
        timestamp: "2025-01-01T00:00:00Z",
        message: "Missing snapshot",
        snapshotIds: ["s_missing"],
        tags: [],
        metadata: {},
      };
      new RepositoryStorage(root).write("commits/missing-snapshot.yaml", commit);

      expect(() => engine.getStateAtCommit(commit.id)).toThrow("Snapshot not found: s_missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unreadable commits and snapshots during reconstruction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Unreadable Reconstruction Objects" });
      engine.addNode({ id: "agent" });
      const snapshot = engine.createSnapshot({
        nodeId: "agent",
        configuration: {},
      });
      const commit = engine.createCommit({
        message: "Snapshot to corrupt",
        author: "Test",
        snapshotIds: [snapshot.id],
      });
      const storage = new RepositoryStorage(root);
      await writeFile(
        path.join(root, storage.pathFor("snapshots", snapshot.id)),
        "id: [unterminated",
      );

      expect(() => engine.getStateAtCommit(commit.id))
        .toThrow(new RegExp(`Failed to read snapshot ${snapshot.id}`));

      const initialCommit = engine.listCommits()
        .find((candidate) => candidate.id !== commit.id)!;
      await writeFile(
        path.join(root, storage.pathFor("commits", initialCommit.id)),
        "id: [unterminated",
      );

      expect(() => engine.getStateAtCommit(commit.id))
        .toThrow(/Failed to read commit .* while reconstructing repository state/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects cyclic commit history during state reconstruction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Cyclic Commit Reconstruction" });
      const storage = new RepositoryStorage(root);
      const timestamp = new Date().toISOString();
      const commit = (id: string, parents: string[]) => ({
        id,
        parents,
        branch: "main",
        author: "Test",
        timestamp,
        message: id,
        snapshotIds: [],
        tags: [],
        metadata: {},
      });
      storage.write("commits/cycle-a.yaml", commit("c_cycle_a", ["c_cycle_b"]));
      storage.write("commits/cycle-b.yaml", commit("c_cycle_b", ["c_cycle_a"]));

      expect(() => engine.getStateAtCommit("c_cycle_a"))
        .toThrow("Commit history cycle detected: c_cycle_a");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("traverses graph edges deterministically without looping on cycles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Graph Test" });
      engine.addNode({
        id: "root",
        edges: [
          { source: "root", target: "b", type: "uses" },
          { source: "root", target: "a", type: "uses" },
        ],
      });
      engine.addNode({
        id: "a",
        edges: [{ source: "a", target: "root", type: "depends-on" }],
      });
      engine.addNode({ id: "b" });

      expect(engine.getChildren("root").map((node) => node.id)).toEqual(["a", "b"]);
      expect(engine.getParents("root").map((node) => node.id)).toEqual(["a"]);
      expect(engine.traverse("root").map((node) => node.id)).toEqual([
        "root", "a", "b",
      ]);
      expect(engine.validate().valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a snapshot by creating a new snapshot and commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Restore Test" });
      engine.addNode({ id: "agent" });
      const original = engine.createSnapshot({
        nodeId: "agent",
        configuration: { prompt: "original" },
      });
      engine.createCommit({
        message: "Original state",
        author: "Test",
        snapshotIds: [original.id],
      });
      const changed = engine.createSnapshot({
        nodeId: "agent",
        configuration: { prompt: "changed" },
      });
      engine.createCommit({
        message: "Changed state",
        author: "Test",
        snapshotIds: [changed.id],
      });

      const restored = engine.restoreSnapshot(original.id, { author: "Test" });

      expect(restored.snapshot.id).not.toBe(original.id);
      expect(restored.snapshot.version).toBe(3);
      expect(restored.snapshot.configuration).toEqual(original.configuration);
      expect(restored.commit.snapshotIds).toEqual([restored.snapshot.id]);
      expect(engine.getSnapshot(original.id)).toEqual(original);
      expect(engine.getBranch("main")?.head).toBe(restored.commit.id);
      expect(engine.validate().valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flags broken references and duplicate ids during validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Validation Test" });
      engine.addNode({ id: "agent" });
      const snapshot = engine.createSnapshot({
        nodeId: "agent",
        configuration: { prompt: "ok" },
      });
      (engine as any).storage.write("commits/ghost.yaml", {
        id: "c_missing",
        branch: "main",
        author: "Test",
        timestamp: new Date().toISOString(),
        message: "Ghost",
        parents: ["c_missing_parent"],
        snapshotIds: [snapshot.id, "s_missing"],
        tags: [],
        metadata: {},
      });
      (engine as any).storage.write("snapshots/dup.yaml", {
        id: snapshot.id,
        nodeId: "agent",
        version: 2,
        createdAt: new Date().toISOString(),
        configuration: { prompt: "dup" },
        capabilities: [],
        connectors: [],
        artifacts: [],
        metadata: {},
      });

      const result = engine.validate();
      expect(result.valid).toBe(false);
      expect(result.issues.some((issue) => issue.code === "MISSING_PARENT_COMMIT")).toBe(true);
      expect(result.issues.some((issue) => issue.code === "MISSING_SNAPSHOT")).toBe(true);
      expect(result.issues.some((issue) => issue.code === "DUPLICATE_ID")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports self-referential and multi-commit cycles during repository validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Cyclic Commit Validation" });
      const storage = new RepositoryStorage(root);
      const timestamp = new Date().toISOString();
      const commit = (id: string, parents: string[]) => ({
        id,
        parents,
        branch: "main",
        author: "Test",
        timestamp,
        message: id,
        snapshotIds: [],
        tags: [],
        metadata: {},
      });
      storage.write("commits/self-cycle.yaml", commit("c_self_cycle", ["c_self_cycle"]));
      storage.write("commits/multi-cycle-a.yaml", commit("c_multi_cycle_a", ["c_multi_cycle_b"]));
      storage.write("commits/multi-cycle-b.yaml", commit("c_multi_cycle_b", ["c_multi_cycle_a"]));

      const cycles = engine.validate().issues.filter((issue) => issue.code === "COMMIT_CYCLE");

      expect(cycles).toHaveLength(2);
      expect(cycles.map((issue) => issue.object).sort()).toEqual([
        "c_multi_cycle_a",
        "c_self_cycle",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      directory: "nodes",
      severity: "error",
      code: "INVALID_OBJECT_DIRECTORY",
      valid: false,
    },
    {
      directory: "extensions",
      severity: "warning",
      code: "EXTENSION_ID_SCAN_FAILED",
      valid: true,
    },
  ] as const)(
    "reports $directory directory listing failures during repository validation",
    async ({ directory, severity, code, valid }) => {
      const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
      try {
        const engine = AISpecEngine.create(root, { name: "Directory Listing Failure" });
        const storage = (engine as any).storage as RepositoryStorage;
        const originalList = storage.list;
        vi.spyOn(storage, "list").mockImplementation((listedDirectory) => {
          if (listedDirectory === directory) {
            throw new Error(`Simulated ${directory} directory read failure`);
          }
          return originalList.call(storage, listedDirectory);
        });

        const result = engine.validate();
        expect(result.valid).toBe(valid);
        expect(result.issues).toContainEqual(expect.objectContaining({
          severity,
          code,
          object: directory,
          message: expect.stringContaining(`Simulated ${directory} directory read failure`),
        }));
      } finally {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("validates supported core objects using their RFC-required fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Object Validation Test" });
      const node = engine.addNode({ id: "agent", extensionField: "ignored" });
      const snapshot = engine.createSnapshot({
        nodeId: node.id,
        configuration: { prompt: "valid" },
      });
      const commit = engine.createCommit({
        message: "Add agent snapshot",
        author: "Test",
        snapshotIds: [snapshot.id],
      });
      const branch = engine.getBranch("main")!;

      expect(engine.validateObject("node", node).valid).toBe(true);
      expect(engine.validateObject("snapshot", snapshot).valid).toBe(true);
      expect(engine.validateObject("commit", commit).valid).toBe(true);
      expect(engine.validateObject("branch", branch).valid).toBe(true);

      const duplicateId = engine.validateObject("node", {
        id: node.id,
        type: "different",
      });
      expect(duplicateId.valid).toBe(false);
      expect(duplicateId.issues.some((issue) => issue.code === "DUPLICATE_ID")).toBe(true);

      new RepositoryStorage(root).write("extensions/extension-collision.yaml", {
        id: "extension-collision",
      });
      const crossTypeDuplicate = engine.validateObject("node", {
        id: "extension-collision",
      });
      expect(crossTypeDuplicate.valid).toBe(false);
      expect(crossTypeDuplicate.issues.some((issue) => issue.code === "DUPLICATE_ID")).toBe(true);

      new RepositoryStorage(root).write("flows/flow-collision.yaml", {
        id: "flow-collision",
      });
      expect(engine.validateObject("node", { id: "flow-collision" }).valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects IDs shared by different specified object types", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Global ID Validation Test" });
      engine.addNode({ id: "shared-id" });
      new RepositoryStorage(root).write("snapshots/shared-id.yaml", {
        id: "shared-id",
        nodeId: "shared-id",
        version: 1,
        createdAt: "2025-01-01T00:00:00Z",
        configuration: {},
        capabilities: [],
        connectors: [],
        artifacts: [],
        metadata: {},
      });
      new RepositoryStorage(root).write("connectors/shared-id.yaml", {
        id: "shared-id",
      });
      new RepositoryStorage(root).write("artifacts/shared-id.yaml", {
        id: "shared-id",
      });
      new RepositoryStorage(root).write("extensions/shared-id.yaml", {
        id: "shared-id",
      });

      const result = engine.validate();
      expect(result.valid).toBe(false);
      expect(result.issues.filter((issue) => issue.code === "DUPLICATE_ID")).toHaveLength(4);
      expect(result.issues.filter((issue) => issue.code === "DUPLICATE_ID")
        .every((issue) => issue.object === "shared-id")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate IDs within connector and artifact categories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Connector Artifact ID Validation Test" });
      new RepositoryStorage(root).write("connectors/connector-duplicate-1.yaml", {
        id: "connector-duplicate",
      });
      new RepositoryStorage(root).write("connectors/connector-duplicate-2.yaml", {
        id: "connector-duplicate",
      });
      new RepositoryStorage(root).write("artifacts/artifact-duplicate-1.yaml", {
        id: "artifact-duplicate",
      });
      new RepositoryStorage(root).write("artifacts/artifact-duplicate-2.yaml", {
        id: "artifact-duplicate",
      });

      const result = engine.validate();
      expect(result.valid).toBe(false);
      expect(result.issues.filter((issue) => issue.code === "DUPLICATE_ID").map((issue) => issue.object).sort())
        .toEqual(["artifact-duplicate", "connector-duplicate"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns when an unreadable extension prevents checking its ID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Unreadable Extension Test" });
      await writeFile(path.join(root, "extensions", "broken.yaml"), "id: [unterminated");

      const objectResult = engine.validateObject("node", {
        id: "candidate-id",
      });
      expect(objectResult.valid).toBe(true);
      expect(objectResult.issues).toEqual([
        expect.objectContaining({
          severity: "warning",
          code: "EXTENSION_ID_SCAN_FAILED",
          object: path.join("extensions", "broken.yaml"),
        }),
      ]);

      const repositoryResult = engine.validate();
      expect(repositoryResult.valid).toBe(true);
      expect(repositoryResult.issues).toEqual([
        expect.objectContaining({
          severity: "warning",
          code: "EXTENSION_ID_SCAN_FAILED",
          object: path.join("extensions", "broken.yaml"),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects impossible UTC calendar timestamps and accepts valid timestamps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Timestamp Validation Test" });
      const node = engine.addNode({ id: "agent" });
      const snapshot = engine.createSnapshot({
        nodeId: node.id,
        configuration: {},
      });
      const commit = engine.createCommit({
        message: "Timestamp test",
        author: "Test",
        snapshotIds: [snapshot.id],
      });
      const branch = engine.getBranch("main")!;
      const validTimestamps = [
        "2024-02-29T23:59:59Z",
        "2025-10-24T03:03:49.923Z",
      ];

      for (const timestamp of validTimestamps) {
        expect(engine.validateObject("snapshot", {
          ...snapshot,
          id: "s_timestamp_candidate",
          createdAt: timestamp,
        }).valid).toBe(true);
        expect(engine.validateObject("commit", {
          ...commit,
          id: "c_timestamp_candidate",
          timestamp,
        }).valid).toBe(true);
        expect(engine.validateObject("branch", {
          ...branch,
          id: "b_timestamp_candidate",
          name: "feature/timestamp-candidate",
          createdAt: timestamp,
        }).valid).toBe(true);
      }

      for (const timestamp of [
        "2025-02-30T00:00:00Z",
        "2025-13-01T00:00:00Z",
        "2025-01-01T24:00:00Z",
        "2025-01-01T00:60:00Z",
        "2025-01-01T00:00:60Z",
      ]) {
        for (const [objectType, object, field] of [
          ["snapshot", snapshot, "createdAt"],
          ["commit", commit, "timestamp"],
          ["branch", branch, "createdAt"],
        ] as const) {
          const result = engine.validateObject(objectType, {
            ...object,
            id: `${object.id}_timestamp_candidate`,
            ...(objectType === "branch"
              ? { name: "feature/timestamp-candidate" }
              : {}),
            [field]: timestamp,
          });
          expect(result.valid, `${objectType} timestamp ${timestamp}`).toBe(false);
          expect(result.issues.some((issue) =>
            issue.code === `INVALID_${objectType.toUpperCase()}`,
          )).toBe(true);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports invalid fields and unresolved object references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Invalid Object Test" });
      const invalidSnapshot = {
        id: "s_invalid",
        nodeId: "missing-node",
        version: 0,
        createdAt: "not-a-timestamp",
        configuration: null,
        capabilities: [],
        connectors: ["missing-connector"],
        artifacts: ["missing-artifact"],
        metadata: {},
      };
      const snapshotWithMissingReferences = {
        id: "s_missing_references",
        nodeId: "missing-node",
        version: 1,
        createdAt: new Date().toISOString(),
        configuration: {},
        capabilities: [],
        connectors: ["missing-connector"],
        artifacts: ["missing-artifact"],
        metadata: {},
      };
      const invalidCommit = {
        id: "c_invalid",
        parents: ["missing-parent"],
        branch: "missing-branch",
        author: "Test",
        timestamp: new Date().toISOString(),
        message: "Invalid references",
        snapshotIds: ["missing-snapshot"],
        tags: [],
        metadata: {},
      };
      const invalidBranch = {
        id: "b_invalid",
        name: "feature/invalid",
        parent: "missing-parent-branch",
        head: "missing-head",
        createdAt: new Date().toISOString(),
        author: "Test",
        tags: [],
        metadata: {},
      };

      const snapshotResult = engine.validateObject("snapshot", invalidSnapshot);
      expect(snapshotResult.valid).toBe(false);
      expect(snapshotResult.issues.some((issue) => issue.code === "INVALID_SNAPSHOT")).toBe(true);

      const snapshotReferenceResult = engine.validateObject(
        "snapshot",
        snapshotWithMissingReferences,
      );
      expect(snapshotReferenceResult.issues.map((issue) => issue.code)).toEqual([
        "MISSING_ARTIFACT",
        "MISSING_CONNECTOR",
        "MISSING_NODE",
      ]);

      const commitResult = engine.validateObject("commit", invalidCommit);
      expect(commitResult.valid).toBe(false);
      expect(commitResult.issues.map((issue) => issue.code)).toEqual([
        "MISSING_BRANCH",
        "MISSING_PARENT_COMMIT",
        "MISSING_SNAPSHOT",
      ]);

      const branchResult = engine.validateObject("branch", invalidBranch);
      expect(branchResult.valid).toBe(false);
      expect(branchResult.issues.map((issue) => issue.code)).toEqual([
        "MISSING_BRANCH_HEAD",
        "MISSING_PARENT_BRANCH",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an invalid result for object types without a defined core format", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-engine-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Unsupported Object Test" });

      const result = engine.validateObject("flow", { id: "flow-1" });

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        {
          severity: "error",
          code: "UNSUPPORTED_OBJECT_TYPE",
          message: "Unsupported AISpec object type: flow.",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
