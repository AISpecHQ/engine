import { describe, expect, it } from "vitest";
import {
  persistCommitAndAdvanceBranch,
  reconstructVersionedState,
} from "../src/index.js";

interface TestSnapshot {
  id: string;
  key: string;
  value: string;
}

interface TestCommit {
  parents: string[];
  snapshotIds: string[];
}

describe("reconstructVersionedState", () => {
  it("reconstructs keyed state across parent commits and merge snapshots", () => {
    const commits = new Map<string, TestCommit>([
      ["base", { parents: [], snapshotIds: ["base-shared", "base-only"] }],
      ["left", { parents: ["base"], snapshotIds: ["left-shared"] }],
      ["right", { parents: ["base"], snapshotIds: ["right-shared", "right-only"] }],
      ["merge", { parents: ["left", "right"], snapshotIds: ["merge-only"] }],
    ]);
    const snapshots = new Map<string, TestSnapshot>([
      ["base-shared", { id: "base-shared", key: "shared", value: "base" }],
      ["base-only", { id: "base-only", key: "base", value: "base" }],
      ["left-shared", { id: "left-shared", key: "shared", value: "left" }],
      ["right-shared", { id: "right-shared", key: "shared", value: "right" }],
      ["right-only", { id: "right-only", key: "right", value: "right" }],
      ["merge-only", { id: "merge-only", key: "merge", value: "merge" }],
    ]);

    const state = reconstructVersionedState(
      "merge",
      {
        readCommit: (id) => commits.get(id),
        readSnapshot: (id) => snapshots.get(id),
        getStateKey: (snapshot) => snapshot.key,
      },
    );

    expect([...state].map(([key, snapshot]) => [key, snapshot.value])).toEqual([
      ["shared", "left"],
      ["base", "base"],
      ["right", "right"],
      ["merge", "merge"],
    ]);
  });

  it("reports missing commits and snapshots", () => {
    expect(() => reconstructVersionedState(
      "missing",
      {
        readCommit: (_id): TestCommit | undefined => undefined,
        readSnapshot: (_id): TestSnapshot | undefined => undefined,
        getStateKey: (snapshot) => snapshot.key,
      },
    )).toThrow("Commit not found: missing");

    expect(() => reconstructVersionedState(
      "commit",
      {
        readCommit: () => ({ parents: [], snapshotIds: ["missing-snapshot"] }),
        readSnapshot: (_id): TestSnapshot | undefined => undefined,
        getStateKey: (snapshot) => snapshot.key,
      },
    )).toThrow("Snapshot not found: missing-snapshot");
  });

  it("rejects cyclic commit ancestry", () => {
    const commits = new Map<string, TestCommit>([
      ["first", { parents: ["second"], snapshotIds: [] }],
      ["second", { parents: ["first"], snapshotIds: [] }],
    ]);

    expect(() => reconstructVersionedState(
      "first",
      {
        readCommit: (id) => commits.get(id),
        readSnapshot: (_id): TestSnapshot | undefined => undefined,
        getStateKey: (snapshot) => snapshot.key,
      },
    )).toThrow("Commit history cycle detected: first");
  });

  it("reconstructs state from a deep history without recursive traversal", () => {
    const commits = new Map<string, TestCommit>();
    const snapshots = new Map<string, TestSnapshot>([
      ["initial", { id: "initial", key: "entity", value: "present" }],
    ]);
    commits.set("commit-0", { parents: [], snapshotIds: ["initial"] });
    for (let index = 1; index <= 10_000; index += 1) {
      commits.set(`commit-${index}`, {
        parents: [`commit-${index - 1}`],
        snapshotIds: [],
      });
    }

    const state = reconstructVersionedState("commit-10000", {
      readCommit: (id) => commits.get(id),
      readSnapshot: (id) => snapshots.get(id),
      getStateKey: (snapshot) => snapshot.key,
    });

    expect(state.get("entity")?.value).toBe("present");
  });
});

describe("persistCommitAndAdvanceBranch", () => {
  it("removes the incomplete commit and preserves both failures if rollback fails", () => {
    const advanceError = new Error("branch write failed");
    const rollbackError = new Error("commit removal failed");
    const commit = { id: "commit-1" };
    const writer = {
      writeCommit: () => {},
      advanceBranch: () => {
        throw advanceError;
      },
      removeIncompleteCommit: () => {
        throw rollbackError;
      },
    };

    let thrown: unknown;
    try {
      persistCommitAndAdvanceBranch(commit, { id: "branch-1" }, "main", writer);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) throw new Error("Expected an AggregateError");
    expect(thrown.errors).toEqual([advanceError, rollbackError]);
    expect(thrown.message).toContain("commit-1");
  });
});
