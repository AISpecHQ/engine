# EngineSpec Engine

**A universal, local-first engine for versioning, integrity, and provenance.**

EngineSpec gives any software project a reliable way to save versions of its work, track changes, recover previous states, and maintain a verifiable history.

Think of it as a version-control engine that applications can use to manage their own data and resources — not just source code.

It works independently of AISpec, AI models, cloud providers, or any particular application.

## Why EngineSpec?

Applications create and modify data constantly. Keeping track of what changed, when it changed, and how to recover an earlier state can become difficult.

EngineSpec provides the underlying infrastructure to:

- Save snapshots of project resources.
- Create immutable commits and maintain history.
- Organize work through branches and tags.
- Compare different versions.
- Merge changes.
- Restore previous states.
- Verify data integrity.
- Track provenance and authorship.
- Work locally, without an internet connection.

**EngineSpec manages the history and integrity of your resources. Your application decides what those resources represent.**

## Installation

```bash
npm install @engine-spec/engine
```

## Quick Start

Initialize an EngineSpec project:

```typescript
import { EngineSpec } from "@engine-spec/engine";

const engine = await EngineSpec.initialize({
  name: "Example project",
  workspace: "./workspace",
  traceStore: {
    scheme: "file",
    value: "./trace-store"
  }
});
```

Capture project resources:

```typescript
const snapshot = await engine.capture({
  selectors: [
    {
      type: "filesystem.directory",
      locator: { path: "." }
    }
  ]
});
```

Create a commit:

```typescript
await engine.commit({
  snapshotId: snapshot.id,
  ref: "heads/main",
  expectedHead: null,
  expectedGeneration: 0,
  author: { id: "local:developer" },
  message: "Initial state"
});
```

Your project now has its first recorded version.

## How It Works

EngineSpec separates your working files from their version history.

### Workspace

The workspace is where your application and project resources live.

EngineSpec does not move your original project data into its history storage unless you explicitly capture it.

### Trace Store

The Trace Store contains the information required to maintain and recover project history.

It includes snapshots, commits, references, content-addressable storage, and recovery information.

These two locations are independent.

### Storage Structure

```text
workspace/
  original project data
  .enginespec/
    workspace.json

trace-store/
  manifest.json
  objects/
  cas/
  refs/
  journal/
  index/
```

The index is disposable and can be rebuilt. Historical objects and CAS content are immutable.

## Core Capabilities

### Versioning
- Snapshots and immutable commits.
- Branches and tags.
- History comparison.
- Merge operations.
- State restoration.

### Integrity
- Canonical JSON objects.
- SHA-256 content identities.
- Content-addressable storage (CAS).
- Deduplication.
- Object validation.

### Provenance
- Author and commit metadata.
- Provenance records.
- Ed25519 signatures.
- Detached signature verification.

### Storage and Recovery
- Local filesystem Trace Stores.
- Atomic reference updates.
- Transaction and recovery mechanisms.
- Offline import and export bundles.

### Adapters

EngineSpec supports different types of resources through adapters.

Built-in adapters:

- `filesystem.file`
- `filesystem.directory`
- `structured.json`

Applications can register custom adapters:

```typescript
engine.registerAdapter(adapter);
```

This allows EngineSpec to work with resources beyond traditional files without introducing application-specific concepts into its Core.

## Architecture

EngineSpec is domain-neutral.

It provides the infrastructure for versioning, storage, integrity, and provenance while leaving application-specific responsibilities to other systems.

| Layer | Responsibility |
|---|---|
| Engine Core | Versioning, snapshots, commits and history |
| Storage | Trace Store, CAS and persistence |
| Adapters | Access to different resource types |
| Identity | Signatures and trust |
| Provenance | History and origin records |
| SDK | Developer-facing integration |
| CLI | Terminal interaction |
| Cloud | Optional remote services |

Cloud, authentication, billing, user interfaces, and application-specific execution are not part of the Engine Core.

## AISpec Compatibility

EngineSpec is independent of AISpec, but it provides an explicit compatibility layer for existing AISpec v0 repositories.

Existing AISpec v0 repositories remain readable and writable through the compatibility API.

Import:

```typescript
import {
  AISpecEngine,
  migrateAISpecV0
} from "@engine-spec/engine/aispec-v0";
```

Migration example:

```typescript
const migrated = await migrateAISpecV0({
  source: "./old-aispec-project",
  workspace: "./project",
  traceStore: {
    scheme: "file",
    value: "./trace"
  }
});
```

Migration is explicit, reversible, and copy-on-migrate.

Opening an existing repository does not automatically rewrite historical objects. Existing commits without signatures remain valid.

## SDK and CLI

For TypeScript applications:

```bash
npm install @engine-spec/typescript-sdk
```

For terminal workflows:

```bash
npm install --global @engine-spec/cli
```

The `aispec` command remains available for compatibility with existing AISpec workflows.

## Development

Clone the repository and install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

The current EngineSpec release includes EngineSpec v2 functionality and AISpec v0 compatibility.

Python integrations use the same TypeScript Core through the EngineSpec runtime protocol rather than implementing separate storage or history rules.

## Design Principles

EngineSpec follows these principles:

1. **Domain-neutral:** It does not depend on a specific application or industry.
2. **Local-first:** Core functionality works without cloud services.
3. **Explicit storage:** Applications control where their workspace and Trace Store reside.
4. **Integrity:** Content identities and immutable historical objects protect recorded data.
5. **Extensible:** Adapters allow different resource types and workflows.
6. **Interoperable:** Applications can integrate through SDKs, APIs, and other interfaces.
7. **Separation of concerns:** The Engine handles history and integrity, while applications handle their own business logic.

## License

Apache License 2.0.

---

**EngineSpec — A universal foundation for versioning, integrity, and provenance.**