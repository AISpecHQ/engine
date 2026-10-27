import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AISpecEngine } from "@aispechq/engine";

const cliEntry = path.resolve(import.meta.dirname, "../dist/cli/index.js");

describe("AISpec CLI", () => {
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  async function createWorkspace(): Promise<{ cwd: string; root: string }> {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "aispec-cli-test-"));
    const cwd = path.join(temporaryRoot, "outside working directory");
    const root = path.join(temporaryRoot, "repository with spaces");
    await mkdir(cwd, { recursive: true });
    return { cwd, root };
  }

  async function createInspectFixture() {
    const { cwd, root } = await createWorkspace();
    const engine = AISpecEngine.create(root, { name: "Inspect fixture" });
    const node = engine.addNode({ id: "inspect-node" });
    const snapshot = engine.createSnapshot({
      nodeId: node.id,
      configuration: { enabled: true },
    });
    const commit = engine.createCommit({
      message: "Inspect fixture commit",
      author: "cli-test",
      snapshotIds: [snapshot.id],
    });
    const branch = engine.getBranch("main")!;
    return { cwd, root, node, snapshot, commit, branch };
  }

  function invoke(cwd: string, args: string[]) {
    return spawnSync(process.execPath, [cliEntry, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, AISPEC_REPOSITORY: "" },
    });
  }

  it("initializes a quoted path from an external cwd and refuses a second init", async () => {
    const { cwd, root } = await createWorkspace();
    const initialized = invoke(cwd, [
      "init",
      root,
      "--name",
      "CLI test repository",
      "--author",
      "cli-test",
      "--json",
    ]);

    expect(initialized.status, initialized.stderr).toBe(0);
    const result = JSON.parse(initialized.stdout) as {
      ok: boolean;
      data: { root: string; manifest: { name: string; aispec: { version: string } } };
    };
    expect(result.ok).toBe(true);
    expect(result.data.root).toBe(root);
    expect(result.data.manifest).toMatchObject({
      name: "CLI test repository",
      aispec: { version: "0.1.0" },
    });
    expect(AISpecEngine.open(root).validate().valid).toBe(true);

    const manifestBefore = await readFile(path.join(root, "aispec.yaml"), "utf8");
    const rejected = invoke(cwd, ["init", root, "--name", "Must not replace", "--json"]);
    expect(rejected.status).toBe(2);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      ok: false,
      error: { code: "TARGET_NOT_EMPTY" },
    });
    expect(await readFile(path.join(root, "aispec.yaml"), "utf8")).toBe(manifestBefore);
  });

  it("refuses to add repository files to a non-empty unrelated directory", async () => {
    const { cwd, root } = await createWorkspace();
    await mkdir(root, { recursive: true });
    const unrelatedFile = path.join(root, "keep.txt");
    await writeFile(unrelatedFile, "preserve");

    const result = invoke(cwd, ["init", root, "--name", "Unsafe init"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Refusing to initialize a non-empty directory");
    expect(await readdir(root)).toEqual(["keep.txt"]);
    expect(await readFile(unrelatedFile, "utf8")).toBe("preserve");
  });

  it("uses the current directory when init has no target path", async () => {
    const { cwd } = await createWorkspace();
    const result = invoke(cwd, ["init", "--name", "Current directory repository", "--json"]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { root: cwd, manifest: { name: "Current directory repository" } },
    });
    expect(AISpecEngine.open(cwd).validate().valid).toBe(true);
  });

  it("validates valid and invalid repositories without changing their files", async () => {
    const { cwd, root } = await createWorkspace();
    const engine = AISpecEngine.create(root, { name: "Validation fixture" });
    const nestedCwd = path.join(root, "nested working directory");
    await mkdir(nestedCwd, { recursive: true });
    const valid = invoke(nestedCwd, ["validate", "--json"]);
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      ok: true,
      data: { valid: true, issues: [] },
    });

    const corruptObject = path.join(root, "nodes", "broken.yaml");
    await writeFile(corruptObject, "id: [unterminated\n");
    const before = await readFile(corruptObject, "utf8");
    const invalid = invoke(cwd, ["validate", "--repo", root, "--json"]);
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      ok: false,
      data: {
        valid: false,
        issues: [expect.objectContaining({
          severity: "error",
          code: "INVALID_OBJECT_FILE",
        })],
      },
    });
    expect(await readFile(corruptObject, "utf8")).toBe(before);
    expect(engine.manifest.name).toBe("Validation fixture");
  });

  it("inspects Nodes, Snapshots, Commits, and Branches through the phase-one CLI", async () => {
    const { cwd, root, node, snapshot, commit, branch } = await createInspectFixture();

    for (const [type, identifier] of [
      ["node", node.id],
      ["snapshot", snapshot.id],
      ["commit", commit.id],
      ["branch", branch.name],
    ]) {
      const inspected = invoke(cwd, [
        "inspect",
        type,
        identifier,
        "--repo",
        root,
        "--json",
      ]);
      expect(inspected.status, inspected.stderr).toBe(0);
      expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: true });
    }
  });

  it("inspects the repository manifest", async () => {
    const { cwd, root } = await createInspectFixture();
    const manifest = invoke(cwd, ["inspect", "manifest", "--repo", root, "--json"]);
    expect(manifest.status).toBe(0);
    expect(JSON.parse(manifest.stdout).data.name).toBe("Inspect fixture");
  });

  it("reports missing objects and unsupported inspection kinds", async () => {
    const { cwd, root } = await createInspectFixture();
    const missing = invoke(cwd, ["inspect", "node", "absent", "--repo", root, "--json"]);
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      ok: false,
      error: { code: "OBJECT_NOT_FOUND" },
    });

    const unsupported = invoke(cwd, ["inspect", "connector", "db", "--repo", root, "--json"]);
    expect(unsupported.status).toBe(2);
    expect(JSON.parse(unsupported.stdout)).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_OBJECT_TYPE" },
    });
  });

  it("uses exit code 3 for Engine read failures and reports unresolved repositories", async () => {
    const { cwd, root } = await createWorkspace();
    AISpecEngine.create(root, { name: "Error fixture" });
    await writeFile(path.join(root, "nodes", "broken.yaml"), "id: [unterminated\n");

    const runtimeFailure = invoke(cwd, [
      "inspect",
      "node",
      "missing",
      "--repo",
      root,
      "--json",
    ]);
    expect(runtimeFailure.status).toBe(3);
    expect(JSON.parse(runtimeFailure.stdout)).toMatchObject({
      ok: false,
      error: { code: "ENGINE_ERROR" },
    });

    const unresolved = invoke(cwd, ["validate", "--repo", path.join(cwd, "absent"), "--json"]);
    expect(unresolved.status).toBe(2);
    expect(JSON.parse(unresolved.stdout)).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_NOT_FOUND" },
    });

    const usage = invoke(cwd, ["not-a-command", "--json"]);
    expect(usage.status).toBe(2);
    expect(JSON.parse(usage.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("creates and persists snapshots from JSON configuration paths with spaces", async () => {
    const { cwd, root } = await createWorkspace();
    const engine = AISpecEngine.create(root, { name: "Snapshot CLI fixture" });
    const node = engine.addNode({ id: "snapshot-cli-node" });
    const configPath = path.join(cwd, "configuration file.json");
    await writeFile(configPath, JSON.stringify({ model: "test-model", enabled: true }));

    const created = invoke(cwd, [
      "snapshot",
      node.id,
      "--config",
      ".\\configuration file.json",
      "--repo",
      root,
      "--json",
    ]);
    expect(created.status, created.stderr).toBe(0);
    const output = JSON.parse(created.stdout) as {
      ok: boolean;
      data: { id: string; nodeId: string; configuration: Record<string, unknown> };
    };
    expect(output.ok).toBe(true);
    expect(output.data.id).toMatch(/^s_/);
    expect(output.data.nodeId).toBe(node.id);
    expect(output.data.configuration).toEqual({ model: "test-model", enabled: true });

    engine.saveRepository();
    const reopened = AISpecEngine.open(root);
    expect(reopened.getSnapshot(output.data.id)).toMatchObject(output.data);
    expect(reopened.validate().valid).toBe(true);

    const invalidConfigPath = path.join(cwd, "invalid config.json");
    await writeFile(invalidConfigPath, '{"model":');
    const invalidJson = invoke(cwd, [
      "snapshot", node.id, "--config", invalidConfigPath, "--repo", root, "--json",
    ]);
    expect(invalidJson.status).toBe(2);
    expect(JSON.parse(invalidJson.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_CONFIG_JSON" },
    });

    const missingNode = invoke(cwd, [
      "snapshot", "absent-node", "--config", configPath, "--repo", root, "--json",
    ]);
    expect(missingNode.status).toBe(2);
    expect(JSON.parse(missingNode.stdout)).toMatchObject({
      ok: false,
      error: { code: "OBJECT_NOT_FOUND" },
    });

    const invalidConfigurationPath = path.join(cwd, "array configuration.json");
    await writeFile(invalidConfigurationPath, JSON.stringify(["not", "an", "object"]));
    const invalidConfiguration = invoke(cwd, [
      "snapshot",
      node.id,
      "--config",
      invalidConfigurationPath,
      "--repo",
      root,
      "--json",
    ]);
    expect(invalidConfiguration.status).toBe(2);
    expect(JSON.parse(invalidConfiguration.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_CONFIGURATION" },
    });

    const missingConfig = invoke(cwd, [
      "snapshot",
      node.id,
      "--config",
      path.join(cwd, "missing config.json"),
      "--repo",
      root,
      "--json",
    ]);
    expect(missingConfig.status).toBe(2);
    expect(JSON.parse(missingConfig.stdout)).toMatchObject({
      ok: false,
      error: { code: "CONFIG_NOT_FOUND" },
    });
  });

  it("creates commits with one or multiple snapshots and persists branch heads", async () => {
    const { cwd, root } = await createWorkspace();
    const engine = AISpecEngine.create(root, { name: "Commit CLI fixture" });
    const node = engine.addNode({ id: "commit-cli-node" });
    const firstSnapshot = engine.createSnapshot({
      nodeId: node.id,
      configuration: { revision: 1 },
    });
    const secondSnapshot = engine.createSnapshot({
      nodeId: node.id,
      configuration: { revision: 2 },
    });
    engine.saveRepository();

    const single = invoke(cwd, [
      "commit",
      "--message",
      "Commit one snapshot",
      "--author",
      "cli-test",
      "--snapshot",
      firstSnapshot.id,
      "--repo",
      root,
      "--json",
    ]);
    expect(single.status, single.stderr).toBe(0);
    const firstCommit = JSON.parse(single.stdout).data as {
      id: string;
      branch: string;
      snapshotIds: string[];
    };
    expect(firstCommit.id).toMatch(/^c_/);
    expect(firstCommit.branch).toBe("main");
    expect(firstCommit.snapshotIds).toEqual([firstSnapshot.id]);

    const multiple = invoke(cwd, [
      "commit",
      "--message",
      "Commit multiple snapshots",
      "--author",
      "cli-test",
      "--snapshot",
      firstSnapshot.id,
      "--snapshot",
      secondSnapshot.id,
      "--repo",
      root,
      "--json",
    ]);
    expect(multiple.status, multiple.stderr).toBe(0);
    const secondCommit = JSON.parse(multiple.stdout).data as {
      id: string;
      branch: string;
      parents: string[];
      snapshotIds: string[];
    };
    expect(secondCommit.id).toMatch(/^c_/);
    expect(secondCommit.branch).toBe("main");
    expect(secondCommit.parents).toEqual([firstCommit.id]);
    expect(secondCommit.snapshotIds).toEqual([firstSnapshot.id, secondSnapshot.id]);

    const missingSnapshot = invoke(cwd, [
      "commit",
      "--message",
      "Missing reference",
      "--author",
      "cli-test",
      "--snapshot",
      "missing-snapshot",
      "--repo",
      root,
      "--json",
    ]);
    expect(missingSnapshot.status).toBe(2);
    expect(JSON.parse(missingSnapshot.stdout)).toMatchObject({
      ok: false,
      error: { code: "OBJECT_NOT_FOUND" },
    });

    const missingBranch = invoke(cwd, [
      "commit",
      "--message",
      "Missing branch",
      "--author",
      "cli-test",
      "--snapshot",
      firstSnapshot.id,
      "--branch",
      "absent-branch",
      "--repo",
      root,
      "--json",
    ]);
    expect(missingBranch.status).toBe(2);
    expect(JSON.parse(missingBranch.stdout)).toMatchObject({
      ok: false,
      error: { code: "OBJECT_NOT_FOUND" },
    });

    const reopened = AISpecEngine.open(root);
    expect(reopened.getCommit(firstCommit.id)?.snapshotIds).toEqual([firstSnapshot.id]);
    expect(reopened.getCommit(secondCommit.id)?.snapshotIds)
      .toEqual([firstSnapshot.id, secondSnapshot.id]);
    expect(reopened.getBranch("main")?.head).toBe(secondCommit.id);
    expect(reopened.validate().valid).toBe(true);
  });

  it("lists, creates, inspects, and persists branches without overwriting duplicates", async () => {
    const { cwd, root } = await createWorkspace();
    const engine = AISpecEngine.create(root, { name: "Branch CLI fixture" });
    const initialHead = engine.getBranch("main")!.head;

    const listed = invoke(cwd, ["branch", "list", "--repo", root, "--json"]);
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      ok: true,
      data: [expect.objectContaining({ name: "main", head: initialHead })],
    });

    const created = invoke(cwd, [
      "branch",
      "create",
      "feature/cli",
      "--author",
      "cli-test",
      "--from",
      "main",
      "--description",
      "CLI feature branch",
      "--repo",
      root,
      "--json",
    ]);
    expect(created.status, created.stderr).toBe(0);
    const branch = JSON.parse(created.stdout).data as {
      id: string;
      name: string;
      parent?: string;
      head: string;
    };
    expect(branch).toMatchObject({
      name: "feature/cli",
      parent: "main",
      head: initialHead,
    });
    expect(branch.id).toMatch(/^b_/);

    const inspected = invoke(cwd, [
      "branch", "inspect", branch.name, "--repo", root, "--json",
    ]);
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout).data).toEqual(branch);

    const duplicate = invoke(cwd, [
      "branch", "create", branch.name, "--author", "cli-test", "--repo", root, "--json",
    ]);
    expect(duplicate.status).toBe(3);
    expect(JSON.parse(duplicate.stdout)).toMatchObject({
      ok: false,
      error: { code: "BRANCH_ALREADY_EXISTS" },
    });

    const missingBranch = invoke(cwd, [
      "branch",
      "inspect",
      "feature/missing",
      "--repo",
      root,
      "--json",
    ]);
    expect(missingBranch.status).toBe(2);
    expect(JSON.parse(missingBranch.stdout)).toMatchObject({
      ok: false,
      error: { code: "OBJECT_NOT_FOUND" },
    });

    const missingSource = invoke(cwd, [
      "branch",
      "create",
      "feature/from-missing",
      "--author",
      "cli-test",
      "--from",
      "absent-branch",
      "--repo",
      root,
      "--json",
    ]);
    expect(missingSource.status).toBe(2);
    expect(JSON.parse(missingSource.stdout)).toMatchObject({
      ok: false,
      error: { code: "OBJECT_NOT_FOUND" },
    });

    const reopened = AISpecEngine.open(root);
    expect(reopened.getBranch(branch.name)).toEqual(branch);
    expect(reopened.listBranches()).toHaveLength(2);
    expect(reopened.getBranch("main")?.head).toBe(initialHead);
    expect(reopened.validate().valid).toBe(true);
  });

  it("rejects a commit without author and leaves repository history unchanged", async () => {
    const { cwd, root } = await createWorkspace();
    const engine = AISpecEngine.create(root, { name: "Missing commit author fixture" });
    const node = engine.addNode({ id: "missing-author-node" });
    const snapshot = engine.createSnapshot({
      nodeId: node.id,
      configuration: { unchanged: true },
    });
    const before = AISpecEngine.open(root);
    const branchHeadBefore = before.getBranch("main")?.head;
    const commitsBefore = before.listCommits();

    const result = invoke(cwd, [
      "commit",
      "--message",
      "Must be rejected",
      "--snapshot",
      snapshot.id,
      "--repo",
      root,
      "--json",
    ]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining(
          'Example: aispec commit --message "Save state" --snapshot <id> --author "Ada".',
        ),
      },
    });
    const after = AISpecEngine.open(root);
    expect(after.getBranch("main")?.head).toBe(branchHeadBefore);
    expect(after.listCommits()).toEqual(commitsBefore);
    expect(after.getSnapshot(snapshot.id)).toEqual(snapshot);
    expect(after.validate().valid).toBe(true);
  });

  it("rejects branch creation without author and leaves branches unchanged", async () => {
    const { cwd, root } = await createWorkspace();
    const engine = AISpecEngine.create(root, { name: "Missing branch author fixture" });
    const branchesBefore = engine.listBranches();

    const result = invoke(cwd, [
      "branch",
      "create",
      "feature/no-author",
      "--repo",
      root,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'Example: aispec branch create feature/example --author "Ada".',
    );
    const reopened = AISpecEngine.open(root);
    expect(reopened.listBranches()).toEqual(branchesBefore);
    expect(reopened.validate().valid).toBe(true);
  });
});
