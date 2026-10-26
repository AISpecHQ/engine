import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RepositoryStorage } from "../src/storage.js";

describe("RepositoryStorage", () => {
  it("writes immutable documents without replacing an existing object", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-storage-"));
    try {
      const storage = RepositoryStorage.initialize(root);
      storage.write("nodes/example.yaml", { id: "example", value: 1 });

      expect(() =>
        storage.write("nodes/example.yaml", { id: "example", value: 2 }),
      ).toThrow("Refusing to overwrite immutable object");
      expect(storage.read("nodes/example.yaml")).toEqual({
        id: "example",
        value: 1,
      });
      expect(await readFile(path.join(root, "nodes", "example.yaml"), "utf8"))
        .toContain("value: 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips JSON documents when using a JSON file extension", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-storage-"));
    try {
      const storage = RepositoryStorage.initialize(root);
      const document = {
        id: "json-object",
        nested: { enabled: true, values: [1, "two"] },
      };

      storage.write("nodes/json-object.json", document);

      expect(storage.read("nodes/json-object.json")).toEqual(document);
      expect(await readFile(path.join(root, "nodes", "json-object.json"), "utf8"))
        .toBe(`${JSON.stringify(document, null, 2)}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "../outside.yaml",
    "nodes/../../outside.yaml",
    path.resolve(tmpdir(), "outside.yaml"),
    "nodes/\0invalid.yaml",
  ])("rejects unsafe repository path %s", async (unsafePath) => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-storage-"));
    try {
      const storage = RepositoryStorage.initialize(root);
      expect(() => storage.write(unsafePath, { id: "bad" })).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reading through a symbolic link", async (context) => {
    const { mkdir, symlink, writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "aispec-storage-"));
    const outside = await mkdtemp(path.join(tmpdir(), "aispec-outside-"));
    try {
      const storage = RepositoryStorage.initialize(root);
      await mkdir(path.join(outside, "data"));
      await writeFile(path.join(outside, "data", "secret.yaml"), "id: secret");
      try {
        await symlink(
          path.join(outside, "data"),
          path.join(root, "linked"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
          context.skip();
          return;
        }
        throw error;
      }

      expect(() => storage.read("linked/secret.yaml")).toThrow(
        "Symbolic links are not allowed",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
