export type JsonObject = Record<string, unknown>;

export interface RepositoryManifest {
  id: string;
  name: string;
  aispec: { version: string };
  metadata?: JsonObject;
}

export interface AISpecNode extends JsonObject {
  id: string;
  edges?: GraphEdge[];
}

export interface GraphEdge {
  source: string;
  target: string;
  type?: string;
  [key: string]: unknown;
}

export interface Snapshot {
  id: string;
  nodeId: string;
  version: number;
  createdAt: string;
  configuration: JsonObject;
  capabilities: string[];
  connectors: string[];
  artifacts: string[];
  metadata: JsonObject;
}

export interface Commit {
  id: string;
  parents: string[];
  branch: string;
  author: string;
  timestamp: string;
  message: string;
  snapshotIds: string[];
  tags: string[];
  metadata: JsonObject;
}

export interface Branch {
  id: string;
  name: string;
  parent?: string;
  head: string;
  createdAt: string;
  author: string;
  description?: string;
  tags: string[];
  metadata: JsonObject;
}

export interface ValidationIssue {
  severity: "error" | "warning" | "information";
  code: string;
  message: string;
  object?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface CreateRepositoryOptions {
  name: string;
  version?: string;
  author?: string;
}

export interface CreateSnapshotInput {
  nodeId: string;
  configuration: JsonObject;
  version?: number;
  capabilities?: string[];
  connectors?: string[];
  artifacts?: string[];
  metadata?: JsonObject;
}

export interface CreateCommitInput {
  message: string;
  author: string;
  branch?: string;
  snapshotIds?: string[];
  parents?: string[];
  tags?: string[];
  metadata?: JsonObject;
}

export interface CreateBranchInput {
  name: string;
  author: string;
  from?: string;
  description?: string;
  tags?: string[];
  metadata?: JsonObject;
}

export interface RestoreResult {
  snapshot: Snapshot;
  commit: Commit;
}
