# AISpec CLI design proposal

Status: phases 1 and 2 are implemented (`init`, `validate`, `inspect`,
`snapshot`, `commit`, and `branch list/create/inspect`). Commands outside this
set remain design-only.

## 1. Scope and verified Engine surface

The proposed CLI is a thin local interface to `@aispechq/engine`. It must call
only the package's public exports, not import Engine source files or access its
private storage implementation. The current public entry point exports:

- `AISpecEngine`
- `RepositoryStorage`
- `validateRepository`
- `validateAgainstSchema`
- Public object and input TypeScript types from `src/types.ts`

For normal CLI use, commands should use `AISpecEngine.create()` and
`AISpecEngine.open()`, then call methods on the returned Engine. In particular,
repository validation should call `engine.validate()`; the separately exported
`validateRepository()` takes `RepositoryStorage` and is not needed by the CLI.
`RepositoryStorage` is public but should not be used by CLI commands to bypass
Engine operations.

The Engine's filesystem API is synchronous. Methods throw errors rather than
returning a typed error result. `saveRepository()` synchronizes canonical files;
it does not create another logical repository object. The Engine holds no
persistent file handles and provides no `close()` or `dispose()` method.

There is no working-copy model or separate current-state method. Current state
is obtained by resolving a Branch and passing its `head` to
`getStateAtCommit()`. Creating a Snapshot does not automatically create a
Commit. Creating a Commit advances the selected Branch's head. Restore creates
a new Snapshot and Commit. Merge creates a merge Commit; it does not rewrite
either input history.

## 2. Normative boundary

The RFCs define repository data and Engine/SDK behavior, not a command-line
grammar, option names, human output, or CLI exit codes. The behavior proposed
below is therefore a CLI contract, not a new AISpec requirement.

Relevant contracts:

- [RFC-0001 — Repository Layout](../../aispec-specification/docs/rfc/RFC-0001-Repository-Layout.md):
  root manifest and repository directories.
- [RFC-0002 — Commit Format](../../aispec-specification/docs/rfc/RFC-0002-Commit-Format.md):
  Commit fields, parent history, and Snapshot references.
- [RFC-0003 — Snapshot Format](../../aispec-specification/docs/rfc/RFC-0003-Snapshot-Format.md):
  Snapshot belongs to a Node, records configuration, and is immutable.
- [RFC-0004 — Branch Format](../../aispec-specification/docs/rfc/RFC-0004-Branch-Format.md):
  Branch HEAD and parent references.
- [RFC-0005 — Validation Rules](../../aispec-specification/docs/rfc/RFC-0005-Validation-Rules.md):
  repository validity, object references, IDs, schemas, and graph checks.
- [RFC-0006 — Graph Model](../../aispec-specification/docs/rfc/RFC-0006-Graph-Model.md):
  directed relationships; graph edges do not define execution order.
- [RFC-0009 — Storage Engine](../../aispec-specification/docs/rfc/RFC-0009-Storage-Engine.md)
  and [RFC-0010 — SDK Compliance](../../aispec-specification/docs/rfc/RFC-0010-SDK-Compliance.md):
  canonical storage and synchronization operations.

The CLI must not imply that it executes Nodes, runs Flows, schedules work,
performs a deployment, or computes a Git-style working-tree diff. Those
capabilities are not provided by the current Engine API or these relevant
contracts.

## 3. Command availability summary

“Implementable now” means the current public API provides the operation needed
for the command's stated scope. The implemented command set is listed below;
other rows remain proposals.

| Command | Proposed scope | Current status | Engine operation or blocking capability |
|---|---|---|---|
| `aispec init` | Create a repository and its initial `main` Branch and Commit | Implemented in phase 1 | `AISpecEngine.create(root, options)` |
| `aispec status` | Show repository identity, object counts, and Branch HEADs | Implementable now, read-only summary only | `manifest`, `listNodes()`, `listSnapshots()`, `listCommits()`, `listBranches()` |
| `aispec validate` | Validate the complete repository | Implemented in phase 1 | `AISpecEngine.open()` and `.validate()` |
| `aispec snapshot` | Create a Snapshot for an existing Node from a JSON configuration file | Implemented in phase 2 | `createSnapshot()` |
| `aispec commit` | Create a Commit referencing existing Snapshots and advance a Branch | Implemented in phase 2 | `createCommit()` |
| `aispec branch list` | List Branches and their HEADs | Implemented in phase 2 | `listBranches()` |
| `aispec branch create` | Create a Branch from an existing Branch or Commit | Implemented in phase 2 | `createBranch()` |
| `aispec branch inspect` | Inspect a Branch by name or ID | Implemented in phase 2 | `getBranch()` |
| `aispec merge` | Create a merge Commit on a target Branch | Implementable now | `mergeBranches()` |
| `aispec inspect` | Read a supported object by ID or read the manifest | Implemented in phase 1 for Node, Snapshot, Commit, Branch, and manifest | `getNode()`, `getSnapshot()`, `getCommit()`, `getBranch()`, `manifest` |
| `aispec restore` | Restore a Snapshot by creating new history | Implementable now | `restoreSnapshot()` |
| `aispec branch delete` / checkout | Delete a Branch or change a repository-wide current Branch | Blocked | No public delete or checkout/current-branch operation |
| Node creation / editing | Create or modify Node data through CLI | Partially available in Engine, not in proposed initial CLI | `addNode()` creates a Node; no update operation. Editing CLI input workflow still needs a defined contract. |
| Connector / Artifact management | Create and inspect these object categories through Engine operations | Blocked | No public create/get/list operations or structured TypeScript contracts for these types |

## 4. Shared CLI conventions

### Executable and invocation

The binary name is proposed as `aispec`. Commands should be callable from any
working directory after the CLI package is installed. The CLI must import the
Engine through its package root, for example:

```ts
import { AISpecEngine } from "@aispechq/engine";
```

It must not import `@aispechq/engine/dist/...`, `src/...`, or any other private
package path.

### Repository resolution

Implemented resolution order for phase-one commands that open a repository:

1. `--repo <path>` if supplied (`init` instead takes its positional target).
2. `AISPEC_REPOSITORY` if set.
3. Search from the invoking current working directory upwards for the nearest
   `aispec.yaml`.
4. If none is found, fail with a usage/repository-resolution error and suggest
   `--repo` or running `aispec init`.

The CLI resolves relative paths from the invoking process's current working
directory, not the CLI installation directory. Absolute paths are accepted.
Windows paths containing spaces work when quoted according to the active shell,
for example `--repo "D:\Work Projects\agent"`. The CLI should use Node's path
utilities and pass the resolved repository root to the Engine.

`init` takes an explicit optional target path and does not search for an
existing parent repository. Phase 1 refuses non-empty target directories and
non-directory/symlink targets before calling `create()`. An empty existing
directory or nonexistent target is accepted. The Engine itself also rejects
an existing `aispec.yaml`.

No CLI-specific repository config file is proposed for the first version.
Explicit flags, the environment variable, and ancestor discovery are enough
for the initial command set. If configuration is added later, precedence and
file format must be specified before implementation.

### Output, errors, and exit status

Proposed global `--json` flag:

- Human mode is the default. It prints concise summaries and validation issues
  to standard output; diagnostics and errors go to standard error.
- JSON mode emits exactly one JSON object per command invocation, with no
  banners or progress text on standard output.
- Success JSON uses `{ "ok": true, "data": ... }`.
- Execution/usage failure JSON uses
  `{ "ok": false, "error": { "code": "...", "message": "..." } }`.
- Validation JSON includes the Engine's `valid` flag and complete `issues`
  array in `data`, whether valid or invalid.
- For a completed but invalid `validate`, the envelope is
  `{ "ok": false, "data": { "valid": false, "issues": [...] } }`; it does not
  use the `error` field because validation returned a result rather than
  throwing.

Phase-one exit codes:

| Code | Meaning |
|---|---|
| `0` | Command completed successfully; validation is valid |
| `1` | Repository validation completed and found errors |
| `2` | Invalid command/arguments, unsupported inspect type, unresolved repository, missing object, or unsafe init target |
| `3` | Engine, filesystem, or synchronization failure during execution |

Warnings alone do not make validation fail if `ValidationResult.valid` is true.
The Engine does not expose typed exception classes or stable error codes.
Therefore CLI error codes for thrown Engine errors remain the generic
`ENGINE_ERROR`, with exit code `3`; the CLI does not infer error categories by
parsing human-readable Engine message text. Argument/parser errors use
CLI-owned codes such as `INVALID_ARGUMENT`, `REPOSITORY_NOT_FOUND`,
`OBJECT_NOT_FOUND`, and `UNSUPPORTED_OBJECT_TYPE`, with exit code `2`.

Human errors begin with `aispec:` and include actionable context where
available. JSON errors have stable CLI-owned codes and a message. Stack traces
are not printed by default.

### Read/write policy

Commands should make no implicit Commit or Snapshot beyond what their name
states:

- `snapshot` creates only a Snapshot.
- `commit` creates a Commit and advances its Branch as the Engine does.
- `restore` creates a replacement-state Snapshot plus a Commit, preserving
  prior immutable history.
- Read-only commands do not call `saveRepository()` unless the command contract
  explicitly requests a synchronization barrier.

The Engine persists mutations synchronously, while `saveRepository()` performs
an explicit synchronization step. A mutating command should call
`saveRepository()` before reporting success so synchronization errors are
surfaced. This does not make multi-file operations crash-atomic. If a
synchronization error occurs after an immediate mutation, the Engine does not
promise to roll back that mutation; the CLI must report the error and must not
claim that the repository is unchanged.

## 5. Command contracts

### `aispec init`

**Status:** Implemented in phase 1.

**Syntax**

```text
aispec init [<path>] --name <name> [--author <author>] [--version <semver>]
            [--json]
```

**Behavior:** Resolve `<path>` relative to the invoking CWD; default to `.`.
Require `--name`. `--author` and `--version` map to `CreateRepositoryOptions`;
the Engine defaults author to `system` and version to `0.1.0`. Create the
repository and call `saveRepository()` before success. Do not initialize over
an existing AISpec repository.

**Exit/error:** `0` on success; `2` for missing/invalid arguments, an existing
repository, or a non-empty/symlink/non-directory target; `3` for IO or
synchronization failure. Init refuses any existing non-empty target directory
to protect unrelated user files.

**Files:** Writes `aispec.yaml`, initial Commit and Branch objects, and the
canonical layout directories. It must not write outside the selected root.

**Engine mapping:** `AISpecEngine.create()` then `saveRepository()`.

**Blockers:** None for phase one. Empty existing directories and nonexistent
targets are accepted; non-empty targets are refused before calling the Engine.

### `aispec status`

**Status:** Implementable now only as a repository summary, not as a working
tree status.

**Syntax**

```text
aispec status [--repo <path>] [--json]
```

**Behavior:** Print repository name/ID and AISpec version; counts of Nodes,
Snapshots, Commits, and Branches; and each Branch's name and HEAD Commit ID.
No “modified/untracked/staged” state is reported. The Engine has no mutable
working-copy or diff model.

**Exit/error:** `0` on successful read; `2` if no repository can be resolved;
`3` on corrupted/unreadable repository data.

**Files:** Reads `aispec.yaml`, `nodes/`, `snapshots/`, `commits/`, and
`branches/`; does not modify repository files.

**Engine mapping:** `manifest`, the four relevant list methods, and optionally
`getCommit()` to show HEAD messages. Showing only IDs avoids unnecessary reads.

**Blockers:** A Git-like “what changed?” status is blocked by the lack of a
working-copy/change-tracking API. Do not label this summary as a Git status.

### `aispec validate`

**Status:** Implemented in phase 1.

**Syntax**

```text
aispec validate [--repo <path>] [--json]
```

**Behavior:** Open the repository and run full repository validation. In human
mode, print `valid` or `invalid`, followed by each issue's severity, code,
message, and object when present. In JSON mode, return the full result.

**Exit/error:** `0` if `ValidationResult.valid` is true, including warning-only
results; `1` if validation returns invalid; `2` if the repository cannot be
resolved or arguments are invalid; `3` if opening/validation fails with an
Engine or filesystem error.

**Files:** Reads the manifest and repository object files, and uses the
installed Engine package's schemas. Does not modify repository data.

**Engine mapping:** `AISpecEngine.open(root).validate()`.

**Blockers:** None for full repository validation. Object-specific validation
would require an input document and separate option contract; it is not part of
this command initially.

### `aispec snapshot`

**Status:** Implemented in phase 2 for a Snapshot on an existing Node.

**Syntax**

```text
aispec snapshot <node-id> --config <json-file> [--repo <path>] [--json]
```

**Behavior:** Read and parse `--config` as a JSON object; pass it as
`configuration`. The Engine assigns the Snapshot ID, UTC timestamp, and next
Node version. The CLI currently exposes no flags for capabilities, Connector
references, Artifact references, or metadata. Print the created Snapshot. Do
not automatically create a Commit.

**Exit/error:** `0` on success; `2` for missing options, a missing config file,
invalid JSON, a non-object configuration, or a missing Node; `3` for other
Engine/IO errors, including unresolved Connector/Artifact references.

**Files:** Reads the selected config file and the repository's existing Node,
Snapshot, Connector, and Artifact data as needed. Writes one immutable object
under `snapshots/`. `saveRepository()` synchronizes canonical files.

**Engine mapping:** `createSnapshot(input)` then `saveRepository()`.

**Blockers:** No blocker when references already exist. The public Engine API
cannot create or manage Connector/Artifact documents, so this command cannot
make such references available itself. Config input is proposed as JSON only;
YAML config support would require a separately agreed CLI parser contract.

### `aispec commit`

**Status:** Implemented in phase 2.

**Syntax**

```text
aispec commit --message <message> --snapshot <snapshot-id>
              [--snapshot <snapshot-id> ...] --author <author>
              [--branch <name>] [--repo <path>] [--json]
```

**Behavior:** Require at least one `--snapshot` and an author. Create one Commit
on the named Branch, defaulting to `main`. Repeated `--snapshot` values become
`snapshotIds`; the CLI checks that the Branch and Snapshots exist, then the
Engine validates the parent and references, records the current Branch HEAD as
the default parent, and advances the Branch. Print the Commit and new HEAD.

**Exit/error:** `0` on success; `2` for invalid/missing CLI arguments or
missing Branch/Snapshot objects; `3` for Engine/IO/synchronization errors.

**Files:** Reads the selected Branch, parent Commits, and referenced Snapshots.
Writes one immutable Commit and updates that Branch's canonical file. Calls
`saveRepository()` before reporting success.

**Engine mapping:** `createCommit(input)` then `saveRepository()`.

**Blockers:** No blocker for the common single-parent commit. A CLI merge should
use `merge`, not expose arbitrary parent lists through ordinary `commit`.

### `aispec merge`

**Status:** Implementable now.

**Syntax**

```text
aispec merge <source-branch> --into <target-branch>
             --author <author> --message <message>
             [--repo <path>] [--json]
```

**Behavior:** Create a merge Commit whose first parent is the target Branch
HEAD and whose second parent is the source Branch HEAD. Advance only the target
Branch. The Engine reconstructs merged state from both parents, with the
target's first-parent state winning when both histories change the same Node.
The CLI must call this a merge Commit; it must not imply that it edited or
rewrote either Branch's existing history.

**Exit/error:** `0` on success; `2` for missing or invalid arguments; `3` for
Engine/IO/synchronization errors, including missing Branches or merging a
Branch into itself.

**Files:** Reads both Branches and their HEAD Commits. Writes one immutable
Commit and updates the target Branch file; it leaves the source Branch
unchanged. Calls `saveRepository()` before reporting success.

**Engine mapping:** `mergeBranches(source, target, author, message)` then
`saveRepository()`.

**Blockers:** No Engine blocker for the Engine's existing merge behavior. The
CLI must not claim conflict resolution beyond the documented first-parent
state precedence.

### `aispec branch`

**Status:** Listing, creation, and inspection are implemented in phase 2.

**Syntax**

```text
aispec branch list [--repo <path>] [--json]
aispec branch create <name> --author <author> [--from <branch-or-commit>]
                           [--description <text>] [--repo <path>] [--json]
aispec branch inspect <name-or-id> [--repo <path>] [--json]
```

**Behavior:** `list` prints each Branch and its HEAD. `create` requires an
author, creates a Branch from `--from` (default `main`), and prints its ID,
parent (when present), and HEAD. It refuses an existing name. `inspect` reads
one Branch by name or ID. A created Branch is not a checked-out working
context: later commits must explicitly use `--branch <name>`.

**Exit/error:** `0` on success; `2` for invalid usage or a missing source/
inspected Branch; `3` for Engine/IO errors, including duplicate names.

**Files:** `list` reads `branches/`; `create` reads source Branch/Commit data,
writes one Branch under `branches/`, and synchronizes it.

**Engine mapping:** `listBranches()`, `createBranch(input)`, or `getBranch()`;
mutations call `saveRepository()`.

**Blockers:** Branch deletion and checkout/current-branch switching are not
available. Do not advertise `branch delete`, `branch switch`, or `checkout`.

### `aispec inspect`

**Status:** Implemented in phase 1 for supported object types.

**Syntax**

```text
aispec inspect manifest [--repo <path>] [--json]
aispec inspect node <id> [--repo <path>] [--json]
aispec inspect snapshot <id> [--repo <path>] [--json]
aispec inspect commit <id> [--repo <path>] [--json]
aispec inspect branch <name-or-id> [--repo <path>] [--json]
```

**Behavior:** Print the corresponding public object in a stable, readable
field order; JSON mode emits the object unchanged. A missing object is a
not-found error.

**Exit/error:** `0` on success; `2` for unsupported kind, invalid arguments,
missing object, or unresolved repository; `3` if an Engine read fails.

**Files:** Reads only the manifest or relevant object directory via public
Engine getters. No writes.

**Engine mapping:** `manifest`, `getNode()`, `getSnapshot()`, `getCommit()`, or
`getBranch()`.

**Blockers:** Connector, Artifact, Flow, Evaluation, and Environment inspection
is blocked by the lack of typed public getters/list methods. The generic
`RepositoryStorage` export must not be used as an undocumented substitute.

### `aispec restore`

**Status:** Implementable now, though not in the initial suggested command
list.

**Syntax**

```text
aispec restore <snapshot-id> --author <author>
                [--message <message>] [--branch <name>]
                [--repo <path>] [--json]
```

**Behavior:** Create a new Snapshot copying the selected Snapshot's state, then
create a Commit on the requested Branch (default `main`). State clearly that
the original Snapshot and history are retained. Output both new IDs.

**Exit/error:** `0` on success; `2` for invalid arguments; `3` for Engine/IO
errors, including a missing Snapshot or Branch.

**Files:** Reads the original Snapshot, referenced data and selected Branch;
writes a new Snapshot and Commit and updates the Branch. Calls
`saveRepository()` before success.

**Engine mapping:** `restoreSnapshot(id, options)` then `saveRepository()`.

**Blockers:** No Engine blocker. A failed operation may perform compensating
synchronous cleanup, but this is not a crash-safe multi-file transaction.

## 6. Architecture proposal

### Minimal package structure

Keep CLI command handling in a separate module that consumes the Engine's
public API. Phase 1 ships the binary alongside the Engine package and declares
it in that package's `bin` field; a later independently versioned CLI package
may be considered separately:

```text
aispec-engine/
  package.json             # "bin": { "aispec": "./dist/cli/index.js" }
  cli/
    index.ts               # phase-one argument parsing and command dispatch
  src/
    engine.ts              # Engine implementation; not imported by CLI
    index.ts               # public package entry point
  dist/
    cli/index.js            # compiled executable with node shebang
```

The CLI imports only `@aispechq/engine`. It must not copy schemas or reach into
Engine source. The Engine locates its schemas relative to its installed module,
which allows validation from a different process CWD.

At design time, the Engine tarball has been installed and exercised locally;
registry publication/availability has not been established. Until that is
decided, a CLI development environment must depend on the verified Engine
tarball or a local package path, rather than assuming
`npm install @aispechq/engine` can retrieve a published version.

### Argument parsing

The phase-one CLI handles its small command/option set with Node's built-in
`process.argv` and adds no parser dependency. If later commands make parsing
substantially more complex, compare a maintained parser with the built-in
approach; prefer keeping CLI-only dependencies in a separately packaged CLI
when/if that package is introduced.

### Path and data handling

- Resolve relative repository and input-file paths against `process.cwd()`.
- Never resolve user paths relative to `import.meta.url` or the installation
  directory.
- Support spaces by accepting normal shell-quoted arguments; do not manually
  split a path string.
- Use `path.resolve()` for repository selection and pass the resulting
  absolute root to `AISpecEngine`.
- Keep repository discovery in the CLI layer; do not add discovery semantics
  to the Engine API.
- For the initial `snapshot --config`, accept JSON only and validate that the
  parsed top-level value is an object before calling the Engine.
- Never overwrite arbitrary files in `init`'s target directory.

### Output and testability

Keep command handlers as functions that accept parsed arguments and injected
streams/process CWD where useful. This allows deterministic unit tests without
shelling out for every case. Retain at least one subprocess test per public
entry point to verify the installed executable, Windows-compatible paths,
JSON output, exit statuses, and error stream separation. Test from a CWD outside
the repository and outside the CLI installation directory.

## 7. Examples

PowerShell examples (quote paths containing spaces):

```powershell
aispec init ".\Agent Project" --name "Agent Project" --author "Ada"
aispec status --repo ".\Agent Project"
aispec validate --repo ".\Agent Project" --json
aispec branch create "feature/router" --author "Ada" --repo ".\Agent Project"
aispec snapshot "router-node" --config ".\router-config.json" `
  --repo ".\Agent Project"
aispec commit --message "Add router snapshot" --author "Ada" `
  --snapshot "s_..." --branch "feature/router" --repo ".\Agent Project"
aispec inspect commit "c_..." --repo ".\Agent Project"
aispec restore "s_..." --author "Ada" --repo ".\Agent Project"
```

The Engine generates Snapshot and Commit IDs. Examples use placeholders; users
should obtain the actual IDs from command output or `inspect`.

## 8. Implementation plan

1. **CLI contract and runtime floor:** approve command spellings, option
   precedence, output envelopes, exit codes, and supported Node.js versions.
   The Engine package currently does not declare an `engines.node` floor.
2. **Package skeleton and path resolution:** create a separate CLI package,
   public Engine dependency, binary entry point, argument parsing, `--help`,
   `--version`, `--repo`, environment override, ancestor discovery, and JSON
   output. Test from an unrelated CWD with Windows paths containing spaces.
3. **Read-only baseline:** implement `status` and verify no mutation and exact
   exit/error behavior. `validate`, `inspect`, and `branch list` are implemented.
4. **Repository mutations:** implement `snapshot`, `commit`, and `branch
   create`; call `saveRepository()` and report synchronization failures. These
   commands are implemented and covered by subprocess tests for invalid config,
   missing references, duplicate branches, and persistence after reopen.
5. **History operations:** add `restore` and `merge`; report both merge parent
   Commits and the target Branch HEAD update.
6. **Consumer/package validation:** install the CLI tarball plus Engine package
   into a clean temporary consumer, run all documented examples that do not
   require unsupported object categories, check type/runtime entry points, and
   confirm no source-tree dependency.
7. **Deferred APIs:** only after separate Engine API design, consider
   `branch delete`, checkout/current-branch state, generic object inspection,
   Connector/Artifact lifecycle, Node editing, or a working-copy/diff model.

No CLI implementation or new Engine API is part of this design document.
