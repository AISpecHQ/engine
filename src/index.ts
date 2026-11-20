export { AISpecEngine } from "./engine.js";
export { RepositoryStorage } from "./storage.js";
export { validateRepository } from "./validation.js";
export { validateAgainstSchema } from "./schema-validation.js";
export {
  generateSigningKeyPair,
  verifyCommitSignature,
  type CommitSignatureVerification,
  type SigningKeyPair,
} from "./signatures.js";
export {
  persistCommitAndAdvanceBranch,
  type VersionedCommitRecord,
  type VersionedCommitWriter,
} from "./versioning/commit.js";
export {
  reconstructVersionedState,
  type VersionedCommit,
  type VersionedStateReader,
} from "./versioning/state.js";
export { EngineSpecEngine } from "./enginespec/core.js";
export { EngineSpecEngine as EngineSpec } from "./enginespec/core.js";
export { migrateAISpecV0 } from "./enginespec/compatibility.js";
export { EngineSpecError } from "./enginespec/errors.js";
export { LocalContentStore } from "./enginespec/cas.js";
export { LocalTraceStore } from "./enginespec/store.js";
export {
  AdapterRegistry,
  FilesystemAdapter,
  StructuredAdapter,
} from "./enginespec/adapters.js";
export type {
  AdapterMergeResult,
  AdapterRestoreResult,
  DiffChange,
  ResourceAdapter,
  ResourceConflict,
  ResourceSelector,
  RestoreTarget,
} from "./enginespec/adapters.js";
export {
  generateEngineSpecKeyPair,
  LocalSignatureProvider,
  verifyEngineSpecSignature,
} from "./enginespec/identity.js";
export {
  canonicalJson,
  decodeEnvelope,
  digestBytes,
  digestJson,
  encodeEnvelope,
  parseObjectId,
} from "./enginespec/format.js";
export type * from "./enginespec/model.js";
export type {
  AISpecExtension,
  AISpecNode,
  AISpecObjectType,
  Branch,
  Commit,
  CommitParticipant,
  CommitSigningInput,
  CreateBranchInput,
  CreateCommitInput,
  CreateRepositoryOptions,
  CreateSnapshotInput,
  GraphEdge,
  HumanIdentity,
  JsonObject,
  RepositoryManifest,
  RestoreResult,
  Snapshot,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
