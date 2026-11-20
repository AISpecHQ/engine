# EngineSpec Engine

EngineSpec is an open, local-first engine for versioning, integrity, provenance,
branches, merges and restoration of resources from any domain.

It works with files, structured data and custom adapters. It does not know or
require AISpec, AI models, Cloud or Supabase.

## Install

```powershell
npm install @enginespec/engine
```

```ts
import { EngineSpec } from "@enginespec/engine";

const engine = await EngineSpec.initialize({
  name: "Example project",
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

The Trace Store is independent from the workspace. Project data is never moved
into the Trace Store unless it is explicitly captured.

## What the Engine does

- canonical JSON objects with SHA-256 identities;
- local offline Trace Stores;
- content-addressable storage with deduplication;
- complete snapshots and immutable commits;
- atomic branch and tag references;
- compare, merge, restore and validation;
- provenance and detached Ed25519 signatures;
- offline import/export bundles;
- filesystem and structured-resource adapters;
- explicit AISpec v0 compatibility and migration.

## Public APIs

### EngineSpec v2

```ts
import { EngineSpec } from "@enginespec/engine";
```

Use `EngineSpec` for new applications. It is asynchronous and domain-neutral.

### AISpec v0 compatibility

```ts
import {
  AISpecEngine,
  migrateAISpecV0,
} from "@enginespec/engine/aispec-v0";
```

AISpec v0 repositories remain readable and writable. Opening one does not
rewrite historical objects. Commits without signatures remain valid.

```ts
const migrated = await migrateAISpecV0({
  source: "./old-aispec-project",
  workspace: "./project",
  traceStore: { scheme: "file", value: "./trace" },
});
```

Migration is explicit, reversible and copy-on-migrate.

## Storage model

```text
workspace/
  original project data
  .enginespec/workspace.json

trace-store/
  manifest.json
  objects/
  cas/
  refs/
  journal/
  index/
```

`index/` is disposable. Historical objects and CAS content are immutable.

## Adapters

Built-in adapters:

- `filesystem.file`
- `filesystem.directory`
- `structured.json`

Applications can register other adapters without adding domain concepts to the
Core:

```ts
engine.registerAdapter(adapter);
```

## SDK and CLI

TypeScript applications should use:

```powershell
npm install @enginespec/typescript-sdk
```

Terminal users should install:

```powershell
npm install --global @enginespec/cli
enginespec --help
```

The AISpec `aispec` command remains available for compatibility.

The package root is domain-neutral. AISpec v0 compatibility is intentionally
available only from `@enginespec/engine/aispec-v0`.

## Development

```powershell
npm install
npm run build
npm test
```

The Engine currently passes its AISpec v0 and EngineSpec v2 suites. Python uses
the same TypeScript Core through the EngineSpec runtime protocol rather than
duplicating storage or history rules.

## Scope

The Engine owns versioning, storage, integrity and provenance. UI, Cloud,
authentication, billing and domain execution belong to separate products.

Cloud is optional. EngineSpec works fully offline.
