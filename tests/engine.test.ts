import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AISpecEngine } from "../src/engine.js";

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
});
