import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AISpecEngine } from "../src/index.js";

describe("AISpecEngine public API integration", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("persists, merges, restores, validates, and survives a rejected operation", async () => {
    root = await mkdtemp(path.join(tmpdir(), "aispec-engine-integration-"));
    const engine = AISpecEngine.create(root, {
      name: "Public API integration",
      author: "integration-test",
    });

    const rootNode = engine.addNode({
      id: "workflow",
      edges: [{ source: "workflow", target: "worker", type: "uses" }],
    });
    const workerNode = engine.addNode({ id: "worker", type: "agent" });
    expect(engine.getNode(rootNode.id)).toEqual(rootNode);
    expect(engine.getNode(workerNode.id)).toEqual(workerNode);
    expect(engine.getChildren(rootNode.id)).toEqual([workerNode]);
    expect(engine.getParents(workerNode.id)).toEqual([rootNode]);
    expect(engine.traverse(rootNode.id)).toEqual([rootNode, workerNode]);

    const originalSnapshot = engine.createSnapshot({
      nodeId: rootNode.id,
      configuration: { prompt: "original" },
    });
    const initialCommit = engine.createCommit({
      message: "Record initial workflow",
      author: "integration-test",
      snapshotIds: [originalSnapshot.id],
    });
    const featureBranch = engine.createBranch({
      name: "feature/worker",
      author: "integration-test",
    });
    const featureSnapshot = engine.createSnapshot({
      nodeId: workerNode.id,
      configuration: { prompt: "feature worker" },
    });
    const featureCommit = engine.createCommit({
      branch: featureBranch.name,
      message: "Add worker state",
      author: "integration-test",
      snapshotIds: [featureSnapshot.id],
    });
    const mainSnapshot = engine.createSnapshot({
      nodeId: rootNode.id,
      configuration: { prompt: "updated" },
    });
    const mainCommit = engine.createCommit({
      message: "Update workflow state",
      author: "integration-test",
      snapshotIds: [mainSnapshot.id],
    });
    expect(engine.getBranch("main")?.head).toBe(mainCommit.id);
    expect(engine.getBranch(featureBranch.name)?.head).toBe(featureCommit.id);

    const mergeCommit = engine.mergeBranches(
      featureBranch.name,
      "main",
      "integration-test",
      "Merge worker state",
    );
    expect(mergeCommit.parents).toEqual([mainCommit.id, featureCommit.id]);
    expect(engine.getBranch("main")?.head).toBe(mergeCommit.id);
    expect(engine.getStateAtCommit(mergeCommit.id)).toEqual(new Map([
      [rootNode.id, mainSnapshot],
      [workerNode.id, featureSnapshot],
    ]));

    engine.saveRepository();
    const reopened = AISpecEngine.open(root);
    expect(reopened.manifest.name).toBe("Public API integration");
    expect(reopened.listNodes()).toEqual([workerNode, rootNode]);
    expect(reopened.getNode(rootNode.id)?.edges).toEqual([
      { source: "workflow", target: "worker", type: "uses" },
    ]);
    expect(reopened.listSnapshots()).toEqual([
      featureSnapshot,
      originalSnapshot,
      mainSnapshot,
    ]);
    expect(reopened.listCommits()).toHaveLength(5);
    expect(reopened.getCommit(initialCommit.id)).toEqual(initialCommit);
    expect(reopened.getCommit(featureCommit.id)).toEqual(featureCommit);
    expect(reopened.getCommit(mainCommit.id)).toEqual(mainCommit);
    expect(reopened.getCommit(mergeCommit.id)).toEqual(mergeCommit);
    expect(reopened.listBranches()).toHaveLength(2);
    expect(reopened.getBranch("feature/worker")?.head).toBe(featureCommit.id);
    expect(reopened.getBranch("main")?.head).toBe(mergeCommit.id);
    expect(reopened.getStateAtCommit(mergeCommit.id)).toEqual(new Map([
      [rootNode.id, mainSnapshot],
      [workerNode.id, featureSnapshot],
    ]));
    expect(reopened.validate()).toEqual({ valid: true, issues: [] });

    const restored = reopened.restoreSnapshot(originalSnapshot.id, {
      author: "integration-test",
      message: "Restore original workflow",
    });
    expect(restored.snapshot.id).not.toBe(originalSnapshot.id);
    expect(restored.snapshot.nodeId).toBe(rootNode.id);
    expect(restored.snapshot.version).toBe(3);
    expect(restored.snapshot.configuration).toEqual({ prompt: "original" });
    expect(restored.commit.snapshotIds).toEqual([restored.snapshot.id]);
    expect(restored.commit.parents).toEqual([mergeCommit.id]);
    expect(reopened.getBranch("main")?.head).toBe(restored.commit.id);
    expect(reopened.getStateAtCommit(restored.commit.id).get(rootNode.id))
      .toEqual(restored.snapshot);
    expect(reopened.getStateAtCommit(restored.commit.id).get(workerNode.id))
      .toEqual(featureSnapshot);
    expect(reopened.validate()).toEqual({ valid: true, issues: [] });

    expect(() => reopened.createSnapshot({
      nodeId: "missing-node",
      configuration: { prompt: "invalid" },
    })).toThrow("Node not found: missing-node");
    expect(reopened.listSnapshots()).toHaveLength(4);
    expect(reopened.listCommits()).toHaveLength(6);
    expect(reopened.getBranch("main")?.head).toBe(restored.commit.id);
    expect(reopened.getSnapshot(originalSnapshot.id)).toEqual(originalSnapshot);
    expect(reopened.validate()).toEqual({ valid: true, issues: [] });
  });
});
