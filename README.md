# AISpec Engine

Reference implementation of the AISpec repository engine. This repository is
separate from `development-system`: it manages AISpec repository data and does
not run AI models, orchestrate engineering tasks, or provide a CLI.

## Current implementation status

The initial TypeScript implementation is present and the package builds. Basic
repository creation, reopening, persistence, and duplicate protection have
tests. The broader operations are not yet fully verified; do not treat them as
production-ready.

The current source is organized as follows:

- `src/engine.ts` — repository creation/opening, nodes, snapshots, commits,
  branches, graph traversal, and snapshot restore operations.
- `src/storage.ts` — filesystem-backed YAML/JSON reads and writes.
- `src/validation.ts` — repository, object, reference, and graph validation.
- `src/types.ts` — TypeScript interfaces for the current object model.
- `src/index.ts` — package exports.

The repository format is intended to follow the official AISpec specification
and RFCs, especially RFC-0001 (layout), RFC-0002 (commits), RFC-0003
(snapshots), RFC-0004 (branches), RFC-0005 (validation), RFC-0006 (graph), and
RFC-0009 (storage). These documents are normative; implementation behavior
must not silently replace or extend their requirements.

`saveRepository()` is an explicit synchronization barrier. It flushes the
contents of the manifest and canonical repository object files through the
operating system, without changing repository contents. It is idempotent, but
does not provide atomic multi-file persistence or guarantee directory-entry
metadata durability; see RFC-0010 and RFC-0009.

## Reproducible checks

Run from this repository:

```powershell
npm install
npm run build
npm test
```

Last checked on 2026-10-23:

- `npm run build` passes.
- `npm test` passes: 1 test file, 3 tests.

The Engine remains an early prototype. Its build and basic repository
operations are verified, but branch/history semantics, full validation,
restore, and storage security still need focused tests.

## Next engineering steps

1. Test immutable object writes, path traversal rejection, and symlink
   protection.
2. Add validation tests for malformed objects, duplicate identifiers, broken
   references, branch heads, snapshots, and graph edges.
3. Test commit/branch history and restore semantics, including that restore
   creates a new Snapshot and Commit rather than mutating history.
4. Compare all behavior with the current RFCs and document any specification
   ambiguity instead of guessing.
5. Only after the Engine API and tests are stable, implement the separate
   `aispec-cli` on top of the public Engine API.

## Scope

The Engine owns canonical repository persistence and operations. User
interaction belongs in the CLI; model execution and task orchestration belong
in separate tooling. Snapshots and Commits are immutable, and restoring a
previous state must create new history rather than rewrite existing objects.

For current ecosystem status and handoff context, see the Developer Guide's
[`CURRENT_STATUS.md`](../developer-guide/CURRENT_STATUS.md).
