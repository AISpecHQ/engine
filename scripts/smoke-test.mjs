import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AISpecEngine } from "../dist/src/index.js";

let root;

try {
  root = await mkdtemp(path.join(tmpdir(), "aispec-engine-smoke-"));
  let engine = AISpecEngine.create(root, {
    name: "AISpec Engine Smoke Test",
    author: "smoke-test",
  });

  const node = engine.addNode({
    id: "smoke-test-node",
    type: "agent",
    label: "Smoke test agent",
  });
  const snapshot = engine.createSnapshot({
    nodeId: node.id,
    configuration: { prompt: "Smoke test" },
  });
  const commit = engine.createCommit({
    message: "Create smoke test snapshot",
    author: "smoke-test",
    snapshotIds: [snapshot.id],
  });

  engine.saveRepository();
  const state = engine.getStateAtCommit(commit.id);
  assert.deepEqual(state.get(node.id), snapshot);

  engine = null;
  const reopened = AISpecEngine.open(root);
  reopened.saveRepository();
  assert.deepEqual(reopened.getNode(node.id), node);
  assert.deepEqual(reopened.getSnapshot(snapshot.id), snapshot);
  assert.deepEqual(reopened.getCommit(commit.id), commit);
  assert.deepEqual(reopened.getStateAtCommit(commit.id).get(node.id), snapshot);

  const validation = reopened.validate();
  assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2));

  console.log("AISpec Engine smoke test passed.");
} finally {
  if (root) await rm(root, { recursive: true, force: true });
}
