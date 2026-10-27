# AISpec Engine

Reference implementation of the AISpec repository engine. This repository is
separate from `development-system`: it manages AISpec repository data and does
not run AI models or orchestrate engineering tasks. It includes a phase-one
local CLI for repository initialization, validation, and supported-object
inspection.

## Current implementation status

The TypeScript implementation is present and its core repository lifecycle is
verified. Repository creation, reopening, persistence, duplicate protection,
branch/history behavior, graph traversal, snapshot restore, and validation checks
all pass in the current test suite.

This is still not a production-ready reference implementation, but the Engine
foundation is now materially more complete than the initial prototype.

The current source is organized as follows:

- `src/engine.ts` — repository creation/opening, nodes, snapshots, commits,
  branches, graph traversal, and snapshot restore operations.
- `src/storage.ts` — filesystem-backed YAML/JSON reads and writes.
- `src/validation.ts` — repository validation and RFC-based object/reference
  checks exposed through `AISpecEngine.validateObject(type, value)`.
- `src/schema-validation.ts` and `schemas/` — draft 2020-12 JSON Schemas loaded
  and validated with Ajv.
- `src/types.ts` — TypeScript interfaces for the current object model.
- `src/index.ts` — package exports.

`validateObject()` supports Node, Snapshot, Commit, Branch, and Extension.
Structural checks use the Engine-local JSON Schemas; repository references,
global identifier uniqueness, and graph consistency remain additional checks.
The published specification schemas remain empty and are not modified by this
repository. Connector, Artifact, Flow, and other objects without RFC-defined
field contracts do not yet have structural schemas here.

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
npm install --no-fund --no-audit
npm run build
npm test
```

Run `npm test -- --testTimeout=20000` when the default 5-second test timeout is
insufficient on a slower environment.

The Engine is no longer only a smoke test prototype. The current verified scope
covers repository lifecycle, storage safety, branch and commit history,
validation of broken references and cyclic commit histories, graph traversal,
and snapshot restoration. State reconstruction rejects cyclic commit ancestry
instead of returning a partial state.
Repository creation, commit creation, and snapshot restore clean up newly
written objects if a later synchronous write fails. This compensating cleanup
does not provide crash-safe, multi-file transactions.

List operations currently return commits by timestamp and ID, snapshots by node
ID and version, and branches by name. `listSnapshots()` also accepts an optional
node ID filter. RFC-0010 requires the list operations but does not specify their
ordering or filtering semantics; these behaviors are verified implementation
details, not additional RFC requirements.

## Using the public API

The package exposes an ESM entry point and TypeScript declarations. After
installing the published package (or installing this repository by local
path), import the Engine from the package root:

```ts
// Install from npm: npm install @aispechq/engine
// Or install a local checkout: npm install <path-to-aispec-engine>
import { AISpecEngine } from "@aispechq/engine";

const engine = AISpecEngine.create("./my-repository", {
  name: "Example",
  author: "developer",
});
const node = engine.addNode({
  id: "assistant",
  edges: [],
});
const snapshot = engine.createSnapshot({
  nodeId: node.id,
  configuration: { model: "example-model" },
});
const commit = engine.createCommit({
  message: "Add assistant state",
  author: "developer",
  snapshotIds: [snapshot.id],
});

const main = engine.getBranch("main");
if (!main) throw new Error("Main branch was not created");
const currentState = engine.getStateAtCommit(main.head);
engine.saveRepository();

const reopened = AISpecEngine.open("./my-repository");
const validation = reopened.validate();
```

Use `createBranch()` and `mergeBranches(source, target, author, message)` for
branch history. `restoreSnapshot(id, { author, message?, branch? })` creates a
new Snapshot and Commit; it does not rewrite history. `getStateAtCommit(id)`
returns a `Map` from Node ID to Snapshot. There is no separate “current state”
method; resolve a Branch and pass its `head` to `getStateAtCommit()`.

The filesystem API is synchronous: operations throw on errors, so handle
expected failures with `try`/`catch`. The Engine holds no persistent file
handles and currently exposes no `close()` or `dispose()` method.

## CLI (phases 1 and 2)

After building or installing the package, the `aispec` executable supports:

```text
aispec init [<path>] --name <name> [--author <author>] [--version <semver>] [--json]
aispec validate [--repo <path>] [--json]
aispec inspect manifest [--repo <path>] [--json]
aispec inspect <node|snapshot|commit|branch> <id-or-name> [--repo <path>] [--json]
aispec snapshot <node-id> --config <file> [--repo <path>] [--json]
aispec commit --message <message> --snapshot <id> [--snapshot <id> ...]
              --author <author> [--branch <name>] [--repo <path>] [--json]
aispec branch list [--repo <path>] [--json]
aispec branch create <name> --author <author> [--from <branch-or-commit>]
                    [--description <text>] [--repo <path>] [--json]
aispec branch inspect <name-or-id> [--repo <path>] [--json]
```

For `validate`, `inspect`, `snapshot`, `commit`, and `branch`, repository
selection uses `--repo`, then `AISPEC_REPOSITORY`, then ancestor search from
the current directory. `init` refuses non-empty target directories. Exit code
`0` means success, `1` means
validation completed but found errors, `2` means invalid usage, unresolved
repository, unsupported type, missing object, or unsafe init target, and `3`
means an Engine or filesystem execution failure, including duplicate branch
creation. Snapshot configuration is JSON, and its relative path is resolved
from the invoking working directory. Commits require an author and at least
one existing snapshot; branches require an author. Mutations call
`saveRepository()` before reporting success, but the Engine does not guarantee
crash-safe atomicity across all files. JSON output uses a single object on
stdout. `status`, `merge`, and `restore` are not part of this CLI phase.

See [docs/cli-design.md](./docs/cli-design.md) for command behavior, output
contracts, implementation limits, and the planned later phases.

## Next engineering steps

1. Clarify whether list ordering and snapshot filtering are intended API
   guarantees or implementation choices.
2. Improve crash-safe multi-file recovery if the storage contract is extended
   to require it; current compensating cleanup only covers synchronous errors.
3. Validate interoperability against repository fixtures produced by other
   AISpec implementations.
4. Only after the Engine API and tests are stable, implement the separate
   `aispec-cli` on top of the public Engine API.

## Scope

The Engine owns canonical repository persistence and operations. User
interaction belongs in the CLI; model execution and task orchestration belong
in separate tooling. Snapshots and Commits are immutable, and restoring a
previous state must create new history rather than rewrite existing objects.

For current ecosystem status and handoff context, see the Developer Guide's
[`CURRENT_STATUS.md`](../developer-guide/CURRENT_STATUS.md).
