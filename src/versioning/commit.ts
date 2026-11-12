export interface VersionedCommitRecord {
  id: string;
}

export interface VersionedCommitWriter<
  TCommit extends VersionedCommitRecord,
  TBranch,
> {
  writeCommit(commit: TCommit): void;
  advanceBranch(branch: TBranch, commitId: string): void;
  removeIncompleteCommit(commit: TCommit): void;
}

export function persistCommitAndAdvanceBranch<
  TCommit extends VersionedCommitRecord,
  TBranch,
>(
  commit: TCommit,
  branch: TBranch,
  branchName: string,
  writer: VersionedCommitWriter<TCommit, TBranch>,
): void {
  writer.writeCommit(commit);
  try {
    writer.advanceBranch(branch, commit.id);
  } catch (cause) {
    try {
      writer.removeIncompleteCommit(commit);
    } catch (rollbackCause) {
      throw new AggregateError(
        [cause, rollbackCause],
        `Failed to advance branch ${branchName} and remove incomplete commit ${commit.id}`,
      );
    }
    throw cause;
  }
}
