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
export type {
  AISpecExtension,
  AISpecNode,
  AISpecObjectType,
  Branch,
  Commit,
  CreateBranchInput,
  CreateCommitInput,
  CreateRepositoryOptions,
  CreateSnapshotInput,
  GraphEdge,
  JsonObject,
  RepositoryManifest,
  RestoreResult,
  Snapshot,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
