import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RepositoryStorage } from "../src/storage.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

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

  it("removes a newly linked destination when temporary-file cleanup fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aispec-storage-"));
    const targetPath = path.join(root, "nodes", "new-object.yaml");
    const originalError = new Error("Simulated temporary-file cleanup failure");
    let targetExistedAtFailure = false;
    try {
      const storage = RepositoryStorage.initialize(root);
      storage.write("nodes/existing.yaml", { id: "existing", value: "preserve" });
      const unlink = vi.mocked(fs.unlinkSync);
      const originalUnlink = unlink.getMockImplementation()!;
      unlink.mockImplementation((filePath) => {
        const candidatePath = String(filePath);
        if (candidatePath.startsWith(`${targetPath}.`) && candidatePath.endsWith(".tmp")) {
          targetExistedAtFailure = fs.existsSync(targetPath);
          throw originalError;
        }
        return originalUnlink(filePath);
      });

      try {
        const write = (): void => {
          try {
            storage.write("nodes/new-object.yaml", { id: "new-object" });
          } catch (error) {
            expect(error).toBe(originalError);
            throw error;
          }
        };
        expect(write).toThrow(originalError);
      } finally {
        unlink.mockImplementation(originalUnlink);
      }

      expect(targetExistedAtFailure).toBe(true);
      expect(fs.existsSync(targetPath)).toBe(false);
      expect(storage.read("nodes/existing.yaml")).toEqual({
        id: "existing",
        value: "preserve",
      });
      expect(storage.list("nodes")).toEqual([path.join("nodes", "existing.yaml")]);
    } finally {
      vi.restoreAllMocks();
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
