import { access, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");

describe("published package consumer", () => {
  let consumerRoot: string | undefined;

  afterEach(async () => {
    if (consumerRoot) await rm(consumerRoot, { recursive: true, force: true });
    consumerRoot = undefined;
  });

  it("imports the built public API and loads schemas outside the package cwd", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as {
      exports: { ".": { import: string; types: string } };
      main: string;
      types: string;
    };
    await Promise.all([
      access(path.join(projectRoot, packageJson.main)),
      access(path.join(projectRoot, packageJson.types)),
      access(path.join(projectRoot, packageJson.exports["."].import)),
      access(path.join(projectRoot, packageJson.exports["."].types)),
    ]);

    consumerRoot = await mkdtemp(path.join(tmpdir(), "aispec-package-consumer-"));
    const packageDirectory = path.join(
      consumerRoot,
      "node_modules",
      "@aispechq",
      "engine",
    );
    await mkdir(path.dirname(packageDirectory), { recursive: true });
    await symlink(projectRoot, packageDirectory, "junction");

    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import { AISpecEngine, validateAgainstSchema } from "@aispechq/engine";
        import path from "node:path";

        const root = path.join(process.cwd(), "repository");
        const engine = AISpecEngine.create(root, { name: "Installed consumer" });
        const node = engine.addNode({ id: "consumer-node" });
        const snapshot = engine.createSnapshot({
          nodeId: node.id,
          configuration: { prompt: "consumer" },
        });
        const commit = engine.createCommit({
          message: "Consumer commit",
          author: "consumer",
          snapshotIds: [snapshot.id],
        });
        engine.saveRepository();

        const reopened = AISpecEngine.open(root);
        assert.equal(reopened.getNode(node.id).id, node.id);
        assert.equal(reopened.getSnapshot(snapshot.id).id, snapshot.id);
        assert.equal(reopened.getCommit(commit.id).id, commit.id);
        assert.equal(reopened.validate().valid, true);
        assert.deepEqual(validateAgainstSchema("node", { id: "schema-check" }), []);
      `,
    ], {
      cwd: consumerRoot,
      encoding: "utf8",
    });

    expect(child.status, child.stderr || child.stdout).toBe(0);
  });
});
