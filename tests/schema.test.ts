import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AISpecEngine } from "../src/engine.js";
import { RepositoryStorage } from "../src/storage.js";
import { getSchema, validateAgainstSchema } from "../src/schema-validation.js";

const schemaDirectory = fileURLToPath(new URL("../schemas/", import.meta.url));
const timestamp = "2026-01-02T03:04:05Z";

const validObjects = {
  manifest: { aispec: { version: "0.1.0-dev" }, projectExtension: true },
  node: {
    id: "node-1",
    custom: { retained: true },
    edges: [{ source: "node-1", target: "node-2", type: "custom-relation", custom: 1 }],
  },
  commit: {
    id: "commit-1",
    parents: [],
    branch: "main",
    author: "author",
    timestamp,
    message: "message",
    snapshotIds: [],
    extensionField: true,
  },
  snapshot: {
    id: "snapshot-1",
    nodeId: "node-1",
    version: 1,
    createdAt: timestamp,
    configuration: { arbitraryKey: "value" },
    capabilities: [],
    connectors: [],
    artifacts: [],
    extensionField: true,
  },
  branch: {
    id: "branch-1",
    name: "main",
    head: "commit-1",
    createdAt: timestamp,
    author: "author",
    extensionField: true,
  },
  extension: {
    id: "extension-1",
    namespace: "org.example",
    version: "1.2.3",
    requires: { aispec: ">=1.0.0" },
    extensionField: true,
  },
} as const;

describe("AISpec JSON Schemas", () => {
  it("loads every non-empty schema file as JSON and compiles each schema", async () => {
    const filenames = (await readdir(schemaDirectory))
      .filter((filename) => filename.endsWith(".schema.json"))
      .sort();
    expect(filenames).toEqual([
      "aispec.schema.json",
      "branch.schema.json",
      "commit.schema.json",
      "extension.schema.json",
      "node.schema.json",
      "snapshot.schema.json",
    ]);

    for (const filename of filenames) {
      const contents = await readFile(path.join(schemaDirectory, filename), "utf8");
      expect(contents.trim(), filename).not.toBe("");
      const schema: unknown = JSON.parse(contents);
      expect(schema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
      });
    }

    for (const [type, value] of Object.entries(validObjects)) {
      expect(getSchema(type as keyof typeof validObjects)).toMatchObject({
        $id: `urn:aispec:schema:${type === "manifest" ? "aispec" : type}`,
        $schema: "https://json-schema.org/draft/2020-12/schema",
      });
      expect(validateAgainstSchema(type as keyof typeof validObjects, value), type).toEqual([]);
    }
  });

  it.each([
    ["manifest", { aispec: {} }],
    ["node", { edges: [] }],
    ["commit", { ...validObjects.commit, timestamp: undefined }],
    ["snapshot", { ...validObjects.snapshot, configuration: undefined }],
    ["branch", { ...validObjects.branch, head: undefined }],
    ["extension", {
      id: "extension-1",
      namespace: "org.example",
      version: "1.2.3",
    }],
  ] as const)("rejects missing required fields for %s", (type, value) => {
    expect(validateAgainstSchema(type, value).length).toBeGreaterThan(0);
  });

  it.each([
    ["manifest", { aispec: { version: 1 } }],
    ["node", { id: 1 }],
    ["commit", { ...validObjects.commit, parents: "invalid" }],
    ["snapshot", { ...validObjects.snapshot, version: "1" }],
    ["branch", { ...validObjects.branch, createdAt: 123 }],
    ["extension", { ...validObjects.extension, version: 1 }],
  ] as const)("rejects invalid field types for %s", (type, value) => {
    expect(validateAgainstSchema(type, value).length).toBeGreaterThan(0);
  });

  it("accepts optional RFC fields and additional properties without closing schemas", () => {
    expect(validateAgainstSchema("manifest", validObjects.manifest)).toEqual([]);
    expect(validateAgainstSchema("node", { id: "node-only" })).toEqual([]);
    expect(validateAgainstSchema("node", {
      id: "node-with-unmodeled-edges",
      edges: "implementation-specific",
    })).toEqual([]);
    expect(validateAgainstSchema("commit", validObjects.commit)).toEqual([]);
    expect(validateAgainstSchema("snapshot", validObjects.snapshot)).toEqual([]);
    expect(validateAgainstSchema("branch", validObjects.branch)).toEqual([]);
    expect(validateAgainstSchema("extension", validObjects.extension)).toEqual([]);
    expect(validateAgainstSchema("snapshot", {
      ...validObjects.snapshot,
      version: 0,
    })).toEqual([]);
    expect(validateAgainstSchema("manifest", {
      aispec: { version: "0.1.0-01" },
    })).not.toEqual([]);
    expect(validateAgainstSchema("extension", {
      id: "extension-without-requirement",
      namespace: "org.example",
      version: "1.2.3",
    })).not.toEqual([]);
  });

  it("applies schemas and keeps reference checks in Engine validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-schema-"));
    try {
      const engine = AISpecEngine.create(root, { name: "Schema validation test" });
      const node = engine.addNode({ id: "schema-node", extra: "preserved" });
      const initialCommit = engine.listCommits()[0]!;
      expect(engine.validateObject("node", node).valid).toBe(true);

      const snapshot = {
        ...validObjects.snapshot,
        id: "candidate-snapshot",
        nodeId: node.id,
      };
      expect(engine.validateObject("snapshot", snapshot).valid).toBe(true);
      expect(engine.validateObject("snapshot", {
        ...snapshot,
        id: "missing-node-snapshot",
        nodeId: "missing-node",
      }).issues).toContainEqual(expect.objectContaining({ code: "MISSING_NODE" }));

      const commit = {
        ...validObjects.commit,
        id: "candidate-commit",
        branch: "main",
        parents: [],
        snapshotIds: [],
      };
      expect(engine.validateObject("commit", commit).valid).toBe(true);
      expect(engine.validateObject("commit", {
        ...commit,
        id: "missing-parent-commit",
        parents: ["missing-parent"],
      }).issues).toContainEqual(expect.objectContaining({
        code: "MISSING_PARENT_COMMIT",
      }));

      expect(engine.validateObject("branch", {
        ...validObjects.branch,
        id: "candidate-branch",
        name: "feature/schema",
        head: initialCommit.id,
      }).valid).toBe(true);
      expect(engine.validateObject("extension", validObjects.extension).valid).toBe(true);
      expect(engine.validateObject("extension", {
        id: "incomplete-extension",
        version: "1.2.3",
      }).issues).toContainEqual(expect.objectContaining({ code: "INVALID_EXTENSION" }));
      expect(engine.validateObject("node", { id: "invalid-node", edges: "invalid" }).issues)
        .toContainEqual(expect.objectContaining({ code: "INVALID_EDGES" }));

      const storage = new RepositoryStorage(root);
      storage.write("extensions/incomplete.yaml", { id: "incomplete-extension" });
      storage.write("nodes/invalid-node.yaml", { id: "invalid-node", edges: "invalid" });
      const result = engine.validate();
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual(expect.objectContaining({
        severity: "warning",
        code: "INVALID_EXTENSION",
      }));
      expect(result.issues).toContainEqual(expect.objectContaining({
        severity: "error",
        code: "INVALID_EDGES",
        object: "invalid-node",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
