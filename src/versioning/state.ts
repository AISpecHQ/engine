export interface VersionedCommit {
  parents: readonly string[];
  snapshotIds: readonly string[];
}

export interface VersionedStateReader<
  TCommit extends VersionedCommit,
  TSnapshot,
  TStateKey,
> {
  readCommit(id: string): TCommit | undefined;
  readSnapshot(id: string): TSnapshot | undefined;
  getStateKey(snapshot: TSnapshot): TStateKey;
}

export function reconstructVersionedState<
  TCommit extends VersionedCommit,
  TSnapshot,
  TStateKey,
>(
  commitId: string,
  reader: VersionedStateReader<TCommit, TSnapshot, TStateKey>,
): Map<TStateKey, TSnapshot> {
  const states = new Map<string, Map<TStateKey, TSnapshot>>();
  const active = new Set<string>();

  const requireCommit = (id: string): TCommit => {
    let commit: TCommit | undefined;
    try {
      commit = reader.readCommit(id);
    } catch (cause) {
      throw new Error(
        `Failed to read commit ${id} while reconstructing repository state: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
    if (!commit) throw new Error(`Commit not found: ${id}`);
    return commit;
  };

  const requireSnapshot = (id: string): TSnapshot => {
    let snapshot: TSnapshot | undefined;
    try {
      snapshot = reader.readSnapshot(id);
    } catch (cause) {
      throw new Error(
        `Failed to read snapshot ${id} while reconstructing repository state: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
    if (!snapshot) throw new Error(`Snapshot not found: ${id}`);
    return snapshot;
  };

  const stack: { id: string; commit: TCommit; nextParent: number }[] = [];
  const pushCommit = (id: string): void => {
    const commit = requireCommit(id);
    active.add(id);
    stack.push({ id, commit, nextParent: 0 });
  };

  pushCommit(commitId);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const parent = frame.commit.parents[frame.nextParent];

    if (parent !== undefined) {
      frame.nextParent += 1;
      if (states.has(parent)) continue;
      if (active.has(parent)) {
        throw new Error(`Commit history cycle detected: ${parent}`);
      }
      pushCommit(parent);
      continue;
    }

    const state = new Map<TStateKey, TSnapshot>();
    for (const parentId of frame.commit.parents) {
      const parentState = states.get(parentId);
      if (!parentState) {
        throw new Error(`Commit state was not reconstructed: ${parentId}`);
      }
      for (const [key, snapshot] of parentState) {
        if (!state.has(key)) state.set(key, snapshot);
      }
    }
    for (const snapshotId of frame.commit.snapshotIds) {
      const snapshot = requireSnapshot(snapshotId);
      state.set(reader.getStateKey(snapshot), snapshot);
    }

    states.set(frame.id, state);
    active.delete(frame.id);
    stack.pop();
  }

  return new Map(states.get(commitId)!);
}
