# AISpec Engine

Reference implementation of the AISpec repository engine. This repository is
separate from `development-system`: it manages AISpec repository data and does
not run AI models or orchestrate engineering tasks. The user-facing `aispec`
command is published separately by `@iaspec/cli`.

## Current implementation status

The TypeScript implementation is present and its core repository lifecycle is
verified. Repository creation, reopening, persistence, duplicate protection,
branch/history behavior, graph traversal, snapshot restore, and validation checks
all pass in the current test suite.

This is a local, synchronous, filesystem-backed reference implementation. The
test suite covers the repository lifecycle, validation, history operations, and
consumption through the package's public API exports. These checks are not a
formal AISpec certification or a cross-implementation interoperability suite.

The implementation is narrower than the broader Developer Guide architecture:
it provides AISpec repository persistence, validation, graph traversal, and
history, but not yet a workflow execution runtime, a full language parser/IR,
or version-compatibility negotiation. The Developer Guide describes the
intended architecture; the Specification and RFCs remain authoritative for
normative behavior.

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

## EngineSpec v2 local API

The package also exports `EngineSpecEngine`, a domain-neutral, asynchronous API
for EngineSpec v2. It keeps the existing AISpec API unchanged and currently
provides:

- independent workspace and Trace Store locations;
- canonical JSON/JCS envelopes with SHA-256 object IDs;
- content-addressable local storage;
- complete snapshots, commits, branches, tags and compare-and-swap refs;
- filesystem and structured-resource adapters;
- diff, three-way merge, restore and offline bundles;
- detached Ed25519 signatures;
- explicit, copy-on-migrate AISpec v0 migration.

```ts
const engine = await EngineSpecEngine.initialize({
  name: "Example",
  workspace: "./workspace",
  traceStore: { scheme: "file", value: "./trace-store" },
});

const snapshot = await engine.capture({
  selectors: [
    { type: "filesystem.directory", locator: { path: "." } },
  ],
});

await engine.commit({
  snapshotId: snapshot.id,
  ref: "heads/main",
  expectedHead: null,
  expectedGeneration: 0,
  author: { id: "local:developer" },
  message: "Initial state",
});
```

EngineSpec v2 storage is local-first. Cloud is not required. AISpec v0
repositories remain available through `AISpecEngine`; migration uses
`migrateAISpecV0()` and does not rewrite the source repository.

The repository format is intended to follow the official AISpec specification
and RFCs, especially RFC-0001 (layout), RFC-0002 (commits), RFC-0003
(snapshots), RFC-0004 (branches), RFC-0005 (validation), RFC-0006 (graph), and
RFC-0009 (storage). These documents are normative; implementation behavior
must not silently replace or extend their requirements.

`saveRepository()` is an explicit synchronization barrier. It flushes the
contents of the manifest and canonical repository object files through the
operating system, without changing repository contents. It is idempotent, but
does not provide atomic multi-file persistence or guarantee directory-entry
metadata durability. These are explicit limits of the RFC-0009/RFC-0010
contract, not missing guarantees that this implementation can claim to provide.

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
// Install from npm: npm install @iaspec/engine
// Or install a local checkout: npm install <path-to-aispec-engine>
import { AISpecEngine } from "@iaspec/engine";

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

The package also exports `reconstructVersionedState()` as a domain-agnostic
building block. It accepts a `VersionedStateReader` adapter that reads commits
and snapshots and selects each snapshot's state key; it reconstructs parent
history in order, with the first parent winning conflicts, then applies
snapshots from the target commit. It does not create repositories or write
history. The `AISpecEngine` itself continues to enforce the AISpec repository
format and rules.

For example, a project can reconstruct its own resources by supplying its
storage readers and key selector:

```ts
import {
  reconstructVersionedState,
  type VersionedCommit,
  type VersionedStateReader,
} from "@iaspec/engine";

interface DocumentSnapshot {
  documentId: string;
  content: string;
}

const commits = new Map<string, VersionedCommit>([
  ["base", { parents: [], snapshotIds: ["snapshot-1"] }],
  ["head", { parents: ["base"], snapshotIds: [] }],
]);
const snapshots = new Map<string, DocumentSnapshot>([
  ["snapshot-1", { documentId: "doc-1", content: "Initial content" }],
]);
const reader: VersionedStateReader<VersionedCommit, DocumentSnapshot, string> = {
  readCommit: (id) => commits.get(id),
  readSnapshot: (id) => snapshots.get(id),
  getStateKey: (snapshot) => snapshot.documentId,
};
const documentState = reconstructVersionedState("head", reader);
```

`persistCommitAndAdvanceBranch()` is another reusable primitive for storage
adapters: it writes a commit before advancing a branch and removes the
incomplete commit if advancing fails. If cleanup also fails, it reports both
errors in an `AggregateError`. This is rollback behavior, not a multi-file
atomic transaction.

The filesystem API is synchronous: operations throw on errors, so handle
expected failures with `try`/`catch`. The Engine holds no persistent file
handles and currently exposes no `close()` or `dispose()` method.

### Optional commit signatures

`generateSigningKeyPair(passphrase)` creates an Ed25519 key pair with an
encrypted PKCS#8 private key. Store the private key outside the repository and
never commit the key or its passphrase. A passphrase must contain at least
12 characters. Supply the encrypted private key and the declared author's ID,
name, and email in `createCommit({ ..., signing: ... })` to sign a new commit.
Existing callers may continue creating unsigned commits.

`verifyCommitSignature(commit)` returns `valid`, `invalid`, or `unsigned`.
`valid` proves that the commit fields and declared identity match the included
public key's signature. It does not prove that the declared name or email
belongs to the key holder; establishing trust in a key is a separate concern.
For signed commits, `engine.verifySignedCommit(id)` also checks SHA-256
digests of directly referenced Snapshot objects. It does not verify the
contents of external artifacts or the integrity of parent commits. A missing
signature is reported as `unsigned`, including if it was removed outside the
Engine.

`createCommit()` also accepts optional `participants`, recording explicitly
declared human and agent IDs, names, actions, and relationships. Agent entries
include a version and may include a model. These declarations are included
in a signature when the Commit is signed, but are not independent proof of
who acted.

## CLI

The Engine package publishes the repository API only; it does not install an
`aispec` executable. Install `@iaspec/cli` to use the standalone command-line
client. The CLI declares the Engine as a runtime dependency and publishes the
`aispec` command. See the [CLI repository](https://github.com/AISpecHQ/cli) for
its supported commands, output contracts, and development instructions.

## Open verification work

1. Clarify whether list ordering and snapshot filtering are intended API
   guarantees or implementation choices.
2. Validate interoperability against repositories produced by independent
   AISpec implementations; the current tests do not provide that coverage.
3. Consider stronger crash recovery only if a future storage contract requires
   guarantees beyond RFC-0009/RFC-0010.

## Scope

The Engine owns canonical repository persistence and operations. User
interaction belongs in the CLI; model execution and task orchestration belong
in separate tooling. Snapshots and Commits are immutable, and restoring a
previous state must create new history rather than rewrite existing objects.

The Engine is an open-source reference implementation intended to be studied,
reused, and adapted by other versioning projects. Its current API and on-disk
format implement AISpec: another project can use it as a starting point, but
direct integration requires representing data with AISpec objects or adapting
the domain and storage layers. It does not currently track arbitrary project
files or replace Git.

For the intended component responsibilities and boundaries, see the Developer
Guide's [Architecture](../developer-guide/ARCHITECTURE.md).
