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
