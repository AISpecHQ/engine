export type JsonPrimitive = null | boolean | number | string;
export type Json = JsonPrimitive | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

export type EntityId = string;
export type ObjectId = `sha256:${string}`;
export type ObjectKind =
  | "project"
  | "resource"
  | "snapshot"
  | "commit"
  | "signature"
  | "provenance"
  | "membership";

export interface ObjectRef {
  kind: ObjectKind;
  id: ObjectId;
}

export interface ObjectEnvelope<T extends object = JsonObject> {
  format: "enginespec";
  formatVersion: "2.0";
  kind: ObjectKind;
  payload: T;
}

export interface StoreLocator {
  scheme: "file";
  value: string;
}

export interface WorkspaceBinding {
  format: "enginespec-workspace";
  formatVersion: "2.0";
  workspaceId: EntityId;
  projectId: EntityId;
  activeTraceStore: StoreLocator;
  previousTraceStore?: StoreLocator;
}

export interface Workspace {
  workspaceId: EntityId;
  projectId: EntityId;
  location: string;
  traceStore: StoreLocator;
}

export interface Identity {
  id: EntityId;
  displayName?: string;
}

export interface ResourceDescriptor {
  resourceId: EntityId;
  type: string;
  adapterId: string;
  adapterVersion: string;
  locator: JsonObject;
  restoreClass: "portable" | "adapter-required" | "reference-only";
}

export interface ContentAddress {
  algorithm: "sha256";
  digest: string;
  size: number;
}

export interface ContentRef {
  address: ContentAddress;
  mediaType?: string;
}

export interface SnapshotEntry {
  resource: ResourceDescriptor;
  state: "present" | "deleted";
  contentRefs: ContentRef[];
  structuredState?: JsonObject;
}

export interface SnapshotPayload {
  projectId: EntityId;
  createdAt: string;
  entries: SnapshotEntry[];
  provenanceRefs: ObjectId[];
}

export interface CommitPayload {
  projectId: EntityId;
  parents: ObjectId[];
  snapshotId: ObjectId;
  author: Identity;
  timestamp: string;
  message: string;
  tags: string[];
  provenanceRefs: ObjectId[];
}

export interface Ref {
  name: `heads/${string}` | `tags/${string}`;
  target: ObjectId;
  generation: number;
}

export interface ExpectedRef {
  name: Ref["name"];
  target: ObjectId | null;
  generation: number;
}

export interface ProvenancePayload {
  actor: Identity;
  action:
    | "captured"
    | "imported"
    | "transformed"
    | "merged"
    | "restored"
    | "verified"
    | "migrated";
  occurredAt: string;
  inputs: ObjectRef[];
  outputs: ObjectRef[];
  adapter?: { id: string; version: string };
}

export interface SignatureEnvelope {
  formatVersion: "2.0";
  signatureVersion: "2.0";
  algorithm: "ed25519";
  keyId: string;
  publicKey: string;
  identity: Identity;
  scope: "object" | "commit" | "snapshot" | "provenance" | "membership";
  payloadDigest: ObjectId;
  signature: string;
  createdAt?: string;
}

export interface SignaturePayload {
  target: ObjectRef;
  envelope: SignatureEnvelope;
}

export interface Issue {
  severity: "error" | "warning" | "information";
  code: string;
  message: string;
  object?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: Issue[];
}

export interface IntegrityReport extends ValidationResult {
  signatures: SignatureStatus[];
}

export interface SignatureStatus {
  target: ObjectRef;
  signature?: ObjectId;
  cryptographic: "valid" | "invalid" | "unsupported" | "unsigned";
  trust: "trusted" | "unknown" | "untrusted" | "revoked" | "not-evaluated";
}

