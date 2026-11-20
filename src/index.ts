export { EngineSpecEngine, EngineSpecEngine as EngineSpec } from "./enginespec/core.js";
export { EngineSpecError } from "./enginespec/errors.js";
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
  CaptureInput,
  CommitInput,
  MergeInput,
  RestoreInput,
  InitializeInput,
  OpenInput,
  BundleResult,
  ExportBundleInput,
  ImportBundleInput,
  MergeResult,
  RestoreResult,
} from "./enginespec/core.js";
