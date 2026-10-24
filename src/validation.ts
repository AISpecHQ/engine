import type {
  AISpecNode,
  Branch,
  Commit,
  RepositoryManifest,
  Snapshot,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
import { RepositoryStorage } from "./storage.js";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUtc(value: unknown): value is string {
  return isText(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function isTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText);
}

export function validateRepository(storage: RepositoryStorage): ValidationResult {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string, object?: string): void => {
    issues.push({ severity: "error", code, message, ...(object ? { object } : {}) });
  };
  const readObjects = <T>(directory: string): T[] => {
    const result: T[] = [];
    for (const file of storage.list(directory)) {
      try {
        result.push(storage.read<T>(file));
      } catch (cause) {
        error(
          "INVALID_OBJECT_FILE",
          cause instanceof Error ? cause.message : String(cause),
          file,
        );
      }
    }
    return result;
  };

  let manifest: RepositoryManifest | undefined;
  try {
    manifest = storage.read<RepositoryManifest>("aispec.yaml");
    if (
      !isRecord(manifest) ||
      !isText(manifest.id) ||
      !isText(manifest.name) ||
      !isRecord(manifest.aispec) ||
      !isText(manifest.aispec.version) ||
      !/^\d+\.\d+\.\d+$/.test(manifest.aispec.version)
    ) {
      error("INVALID_MANIFEST", "Manifest requires id, name, and a semantic AISpec version.", "aispec.yaml");
    }
  } catch (cause) {
    error("INVALID_MANIFEST", cause instanceof Error ? cause.message : String(cause), "aispec.yaml");
  }

  const nodes = readObjects<AISpecNode>("nodes");
  const snapshots = readObjects<Snapshot>("snapshots");
  const commits = readObjects<Commit>("commits");
  const branches = readObjects<Branch>("branches");
  const connectors = readObjects<RecordValue>("connectors");
  const artifacts = readObjects<RecordValue>("artifacts");

  const index = <T extends { id?: unknown }>(items: T[], type: string): Map<string, T> => {
    const result = new Map<string, T>();
    for (const item of items) {
      if (!isRecord(item) || !isText(item.id)) {
        error(`INVALID_${type.toUpperCase()}`, `${type} must have a non-empty id.`);
        continue;
      }
      if (result.has(item.id)) {
        error("DUPLICATE_ID", `Duplicate ${type} id ${item.id}.`, item.id);
      } else {
        result.set(item.id, item);
      }
    }
    return result;
  };

  const nodeIndex = index(nodes, "node");
  const snapshotIndex = index(snapshots, "snapshot");
  const commitIndex = index(commits, "commit");
  const branchIndex = index(branches, "branch");
  const connectorIds = new Set(connectors.filter(isRecord).map((item) => item.id).filter(isText));
  const artifactIds = new Set(artifacts.filter(isRecord).map((item) => item.id).filter(isText));
  const branchNames = new Map<string, Branch>();

  for (const branch of branches) {
    if (!isRecord(branch) || !isText(branch.name)) {
      error("INVALID_BRANCH", "Branch must have a non-empty name.", String(branch?.id ?? ""));
    } else if (branchNames.has(branch.name)) {
      error("DUPLICATE_BRANCH_NAME", `Duplicate branch name ${branch.name}.`, branch.name);
    } else {
      branchNames.set(branch.name, branch);
    }
  }

  for (const snapshot of snapshots) {
    if (
      !isRecord(snapshot) ||
      !isText(snapshot.nodeId) ||
      !Number.isSafeInteger(snapshot.version) ||
      (snapshot.version as number) < 1 ||
      !isUtc(snapshot.createdAt) ||
      !isRecord(snapshot.configuration) ||
      !isTextArray(snapshot.capabilities) ||
      !isTextArray(snapshot.connectors) ||
      !isTextArray(snapshot.artifacts) ||
      !isRecord(snapshot.metadata)
    ) {
      error("INVALID_SNAPSHOT", "Snapshot has invalid required fields.", String(snapshot?.id ?? ""));
      continue;
    }
    if (!nodeIndex.has(snapshot.nodeId)) {
      error("MISSING_NODE", `Snapshot references missing node ${snapshot.nodeId}.`, snapshot.id);
    }
    for (const id of snapshot.connectors) {
      if (!connectorIds.has(id)) error("MISSING_CONNECTOR", `Missing connector ${id}.`, snapshot.id);
    }
    for (const id of snapshot.artifacts) {
      if (!artifactIds.has(id)) error("MISSING_ARTIFACT", `Missing artifact ${id}.`, snapshot.id);
    }
  }

  for (const commit of commits) {
    if (
      !isRecord(commit) ||
      !isTextArray(commit.parents) ||
      !isText(commit.branch) ||
      !isText(commit.author) ||
      !isUtc(commit.timestamp) ||
      !isText(commit.message) ||
      !isTextArray(commit.snapshotIds) ||
      !isTextArray(commit.tags) ||
      !isRecord(commit.metadata)
    ) {
      error("INVALID_COMMIT", "Commit has invalid required fields.", String(commit?.id ?? ""));
      continue;
    }
    if (!branchNames.has(commit.branch)) {
      error("MISSING_BRANCH", `Commit references missing branch ${commit.branch}.`, commit.id);
    }
    if (commit.parents.length === 1) {
      error("INVALID_MERGE_COMMIT", "Merge commits require at least two parents.", commit.id);
    }
    for (const parent of commit.parents) {
      if (!commitIndex.has(parent)) error("MISSING_PARENT_COMMIT", `Missing parent commit ${parent}.`, commit.id);
    }
    for (const snapshotId of commit.snapshotIds) {
      if (!snapshotIndex.has(snapshotId)) error("MISSING_SNAPSHOT", `Missing snapshot ${snapshotId}.`, commit.id);
    }
  }

  for (const branch of branches) {
    if (
      !isRecord(branch) ||
      !isText(branch.name) ||
      !isText(branch.head) ||
      !isUtc(branch.createdAt) ||
      !isText(branch.author) ||
      !isTextArray(branch.tags) ||
      !isRecord(branch.metadata) ||
      (branch.description !== undefined && typeof branch.description !== "string")
    ) {
      error("INVALID_BRANCH", "Branch has invalid required fields.", String(branch?.id ?? ""));
      continue;
    }
    if (!commitIndex.has(branch.head)) {
      error("MISSING_BRANCH_HEAD", `Branch head ${branch.head} does not exist.`, branch.name);
    }
    if (branch.parent && !branchNames.has(branch.parent)) {
      error("MISSING_PARENT_BRANCH", `Parent branch ${branch.parent} does not exist.`, branch.name);
    }
  }

  for (const node of nodes) {
    if (!isRecord(node) || node.edges === undefined) continue;
    if (!Array.isArray(node.edges)) {
      error("INVALID_EDGES", "Node edges must be an array.", String(node.id));
      continue;
    }
    for (const edge of node.edges) {
      if (!isRecord(edge) || !isText(edge.source) || !isText(edge.target)) {
        error("INVALID_EDGE", "Graph edge requires source and target node ids.", String(node.id));
        continue;
      }
      if (!nodeIndex.has(edge.source)) error("MISSING_EDGE_NODE", `Edge source ${edge.source} does not exist.`, String(node.id));
      if (!nodeIndex.has(edge.target)) error("MISSING_EDGE_NODE", `Edge target ${edge.target} does not exist.`, String(node.id));
    }
  }

  for (const [id, node] of nodeIndex) {
    const snapshotsForNode = snapshots.filter((snapshot) => snapshot.nodeId === id);
    const versions = new Set<number>();
    for (const snapshot of snapshotsForNode) {
      if (Number.isSafeInteger(snapshot.version)) {
        if (versions.has(snapshot.version)) {
          error("DUPLICATE_SNAPSHOT_VERSION", `Node ${id} has duplicate snapshot version ${snapshot.version}.`, id);
        }
        versions.add(snapshot.version);
      }
    }
    void node;
  }

  if (manifest && branches.length === 0) {
    issues.push({ severity: "warning", code: "NO_BRANCHES", message: "Repository has no branches." });
  }
  issues.sort((a, b) =>
    [a.severity, a.code, a.object ?? "", a.message].join(":").localeCompare(
      [b.severity, b.code, b.object ?? "", b.message].join(":"),
    ),
  );
  return { valid: !issues.some((item) => item.severity === "error"), issues };
}
