import type {
  AISpecObjectType,
  AISpecNode,
  Branch,
  Commit,
  RepositoryManifest,
  Snapshot,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
import { RepositoryStorage } from "./storage.js";
import { isDeepStrictEqual } from "node:util";
import { validateAgainstSchema } from "./schema-validation.js";

type RecordValue = Record<string, unknown>;
type CoreObjectType = AISpecObjectType;

const OBJECT_DIRECTORIES = RepositoryStorage.directories();
const IDENTITY_DIRECTORIES = [
  "nodes",
  "snapshots",
  "commits",
  "branches",
  "connectors",
  "artifacts",
  "extensions",
] as const;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUtc(value: unknown): value is string {
  if (!isText(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/
    .exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  return daysInMonth !== undefined && day >= 1 && day <= daysInMonth;
}

function isTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText);
}

export function validateObject(
  storage: RepositoryStorage,
  objectType: string,
  value: unknown,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string, object?: string): void => {
    issues.push({ severity: "error", code, message, ...(object ? { object } : {}) });
  };
  const finish = (): ValidationResult => {
    issues.sort((a, b) =>
      [a.severity, a.code, a.object ?? "", a.message].join(":").localeCompare(
        [b.severity, b.code, b.object ?? "", b.message].join(":"),
      ),
    );
    return { valid: !issues.some((issue) => issue.severity === "error"), issues };
  };

  if (!isCoreObjectType(objectType)) {
    error("UNSUPPORTED_OBJECT_TYPE", `Unsupported AISpec object type: ${objectType}.`);
    return finish();
  }
  if (!isRecord(value)) {
    error("INVALID_OBJECT", "Object must be a mapping.");
    return finish();
  }
  if (!isText(value.id)) {
    error("INVALID_ID", "Object must have a non-empty id.");
    return finish();
  }
  const schemaIssues = validateAgainstSchema(objectType, value);
  if (schemaIssues.length > 0) {
    error(
      `INVALID_${objectType.toUpperCase()}`,
      `Object does not conform to its JSON schema: ${schemaIssues.join("; ")}.`,
      value.id,
    );
    return finish();
  }

  const objects = new Map<string, RecordValue[]>();
  for (const directory of OBJECT_DIRECTORIES) {
    const entries: RecordValue[] = [];
    try {
      for (const file of storage.list(directory)) {
        try {
          const object: unknown = storage.read(file);
          if (isRecord(object)) entries.push(object);
          else error("INVALID_OBJECT_FILE", `Expected an object in ${file}.`, file);
        } catch (cause) {
          if (directory === "extensions") {
            issues.push({
              severity: "warning",
              code: "EXTENSION_ID_SCAN_FAILED",
              message: `Could not inspect extension identifiers in ${file}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              object: file,
            });
          } else {
            error(
              "INVALID_OBJECT_FILE",
              cause instanceof Error ? cause.message : String(cause),
              file,
            );
          }
        }
      }
    } catch (cause) {
      error(
        "INVALID_OBJECT_DIRECTORY",
        cause instanceof Error ? cause.message : String(cause),
        directory,
      );
    }
    objects.set(directory, entries);
  }

  const id = value.id;
  const matchingIds = IDENTITY_DIRECTORIES.flatMap((directory) =>
    (objects.get(directory) ?? []).filter((object) => object.id === id),
  );
  const storedEquivalent = (objects.get(objectDirectory(objectType)) ?? [])
    .some((object) => object.id === id && isDeepStrictEqual(object, value));
  if (matchingIds.length - Number(storedEquivalent) > 0) {
    error("DUPLICATE_ID", `Object id ${id} is already used in the repository.`, id);
  }

  const hasId = (directory: string, referencedId: string): boolean =>
    (objects.get(directory) ?? []).some((object) => object.id === referencedId);

  if (objectType === "node") {
    if (value.edges !== undefined) {
      if (!Array.isArray(value.edges)) {
        error("INVALID_EDGES", "Node edges must be an array.", id);
      } else {
        for (const edge of value.edges) {
          if (!isRecord(edge) || !isText(edge.source) || !isText(edge.target)) {
            error("INVALID_EDGE", "Graph edge requires source and target node ids.", id);
            continue;
          }
          if (edge.source !== id && !hasId("nodes", edge.source)) {
            error("MISSING_EDGE_NODE", `Edge source ${edge.source} does not exist.`, id);
          }
          if (edge.target !== id && !hasId("nodes", edge.target)) {
            error("MISSING_EDGE_NODE", `Edge target ${edge.target} does not exist.`, id);
          }
        }
      }
    }
    return finish();
  }

  if (objectType === "snapshot") {
    const snapshot = value as Partial<Snapshot>;
    if (
      !isText(snapshot.nodeId) ||
      typeof snapshot.version !== "number" ||
      !isUtc(snapshot.createdAt) ||
      !isRecord(snapshot.configuration) ||
      !isTextArray(snapshot.capabilities) ||
      !isTextArray(snapshot.connectors) ||
      !isTextArray(snapshot.artifacts) ||
      (snapshot.metadata !== undefined && !isRecord(snapshot.metadata))
    ) {
      error("INVALID_SNAPSHOT", "Snapshot has invalid required fields.", id);
    } else {
      if (!hasId("nodes", snapshot.nodeId)) {
        error("MISSING_NODE", `Snapshot references missing node ${snapshot.nodeId}.`, id);
      }
      for (const connectorId of snapshot.connectors) {
        if (!hasId("connectors", connectorId)) {
          error("MISSING_CONNECTOR", `Missing connector ${connectorId}.`, id);
        }
      }
      for (const artifactId of snapshot.artifacts) {
        if (!hasId("artifacts", artifactId)) {
          error("MISSING_ARTIFACT", `Missing artifact ${artifactId}.`, id);
        }
      }
    }
    return finish();
  }

  if (objectType === "commit") {
    const commit = value as Partial<Commit>;
    if (
      !isTextArray(commit.parents) ||
      !isText(commit.branch) ||
      !isText(commit.author) ||
      !isUtc(commit.timestamp) ||
      !isText(commit.message) ||
      !isTextArray(commit.snapshotIds) ||
      (commit.tags !== undefined && !isTextArray(commit.tags)) ||
      (commit.metadata !== undefined && !isRecord(commit.metadata))
    ) {
      error("INVALID_COMMIT", "Commit has invalid required fields.", id);
    } else {
      if (!(objects.get("branches") ?? []).some((branch) => branch.name === commit.branch)) {
        error("MISSING_BRANCH", `Commit references missing branch ${commit.branch}.`, id);
      }
      for (const parent of commit.parents) {
        if (!hasId("commits", parent)) {
          error("MISSING_PARENT_COMMIT", `Missing parent commit ${parent}.`, id);
        }
      }
      for (const snapshotId of commit.snapshotIds) {
        if (!hasId("snapshots", snapshotId)) {
          error("MISSING_SNAPSHOT", `Missing snapshot ${snapshotId}.`, id);
        }
      }
    }
    return finish();
  }

  if (objectType === "extension") return finish();

  const branch = value as Partial<Branch>;
  if (
    !isText(branch.name) ||
    !isText(branch.head) ||
    !isUtc(branch.createdAt) ||
    !isText(branch.author) ||
    (branch.tags !== undefined && !isTextArray(branch.tags)) ||
    (branch.metadata !== undefined && !isRecord(branch.metadata)) ||
    (branch.description !== undefined && typeof branch.description !== "string")
  ) {
    error("INVALID_BRANCH", "Branch has invalid required fields.", id);
  } else {
    const branches = objects.get("branches") ?? [];
    if (!hasId("commits", branch.head)) {
      error("MISSING_BRANCH_HEAD", `Branch head ${branch.head} does not exist.`, branch.name);
    }
    if (branch.parent && !branches.some((candidate) => candidate.name === branch.parent)) {
      error("MISSING_PARENT_BRANCH", `Parent branch ${branch.parent} does not exist.`, branch.name);
    }
    if (branches.some((candidate) => candidate.name === branch.name && candidate.id !== id)) {
      error("DUPLICATE_BRANCH_NAME", `Duplicate branch name ${branch.name}.`, branch.name);
    }
  }
  return finish();
}

function isCoreObjectType(value: string): value is CoreObjectType {
  return value === "node" ||
    value === "snapshot" ||
    value === "commit" ||
    value === "branch" ||
    value === "extension";
}

function objectDirectory(objectType: CoreObjectType): string {
  switch (objectType) {
    case "node":
      return "nodes";
    case "snapshot":
      return "snapshots";
    case "commit":
      return "commits";
    case "branch":
      return "branches";
    case "extension":
      return "extensions";
  }
}

export function validateRepository(storage: RepositoryStorage): ValidationResult {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string, object?: string): void => {
    issues.push({ severity: "error", code, message, ...(object ? { object } : {}) });
  };
  const readObjects = <T>(directory: string): T[] => {
    const result: T[] = [];
    let files: string[];
    try {
      files = storage.list(directory);
    } catch (cause) {
      error(
        "INVALID_OBJECT_DIRECTORY",
        cause instanceof Error ? cause.message : String(cause),
        directory,
      );
      return result;
    }
    for (const file of files) {
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
    const schemaIssues = validateAgainstSchema("manifest", manifest);
    if (schemaIssues.length > 0) {
      error(
        "INVALID_MANIFEST",
        `Manifest does not conform to its JSON schema: ${schemaIssues.join("; ")}.`,
        "aispec.yaml",
      );
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
      if (!result.has(item.id)) result.set(item.id, item);
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
  const extensions: RecordValue[] = [];
  try {
    for (const file of storage.list("extensions")) {
      try {
        const extension: unknown = storage.read(file);
        if (isRecord(extension)) {
          const schemaIssues = validateAgainstSchema("extension", extension);
          if (schemaIssues.length > 0) {
            issues.push({
              severity: "warning",
              code: "INVALID_EXTENSION",
              message: `Extension does not conform to its JSON schema: ${schemaIssues.join("; ")}.`,
              object: isText(extension.id) ? extension.id : file,
            });
          }
          if (isText(extension.id)) extensions.push(extension);
        } else {
          issues.push({
            severity: "warning",
            code: "INVALID_EXTENSION",
            message: `Expected an object in ${file}.`,
            object: file,
          });
        }
      } catch {
        issues.push({
          severity: "warning",
          code: "EXTENSION_ID_SCAN_FAILED",
          message: `Could not inspect extension identifiers in ${file}.`,
          object: file,
        });
      }
    }
  } catch (cause) {
    issues.push({
      severity: "warning",
      code: "EXTENSION_ID_SCAN_FAILED",
      message: `Could not inspect extension identifiers: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      object: "extensions",
    });
  }
  const identityObjects: unknown[] = [
    ...nodes,
    ...snapshots,
    ...commits,
    ...branches,
    ...connectors,
    ...artifacts,
    ...extensions,
  ];
  const seenIds = new Set<string>();
  for (const object of identityObjects) {
    if (!isRecord(object) || !isText(object.id)) continue;
    if (seenIds.has(object.id)) {
      error("DUPLICATE_ID", `Duplicate object id ${object.id}.`, object.id);
    } else {
      seenIds.add(object.id);
    }
  }

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
      validateAgainstSchema("snapshot", snapshot).length > 0 ||
      !isRecord(snapshot) ||
      !isText(snapshot.nodeId) ||
      !isUtc(snapshot.createdAt) ||
      !isRecord(snapshot.configuration) ||
      !isTextArray(snapshot.capabilities) ||
      !isTextArray(snapshot.connectors) ||
      !isTextArray(snapshot.artifacts) ||
      (snapshot.metadata !== undefined && !isRecord(snapshot.metadata))
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
      validateAgainstSchema("commit", commit).length > 0 ||
      !isRecord(commit) ||
      !isTextArray(commit.parents) ||
      !isText(commit.branch) ||
      !isText(commit.author) ||
      !isUtc(commit.timestamp) ||
      !isText(commit.message) ||
      !isTextArray(commit.snapshotIds) ||
      (commit.tags !== undefined && !isTextArray(commit.tags)) ||
      (commit.metadata !== undefined && !isRecord(commit.metadata))
    ) {
      error("INVALID_COMMIT", "Commit has invalid required fields.", String(commit?.id ?? ""));
      continue;
    }
    if (!branchNames.has(commit.branch)) {
      error("MISSING_BRANCH", `Commit references missing branch ${commit.branch}.`, commit.id);
    }
    for (const parent of commit.parents) {
      if (!commitIndex.has(parent)) error("MISSING_PARENT_COMMIT", `Missing parent commit ${parent}.`, commit.id);
    }
    for (const snapshotId of commit.snapshotIds) {
      if (!snapshotIndex.has(snapshotId)) error("MISSING_SNAPSHOT", `Missing snapshot ${snapshotId}.`, commit.id);
    }
  }

  const commitsWithParents = new Map<string, Commit>();
  for (const commit of commits) {
    if (isRecord(commit) && isText(commit.id) && isTextArray(commit.parents)) {
      commitsWithParents.set(commit.id, commit as Commit);
    }
  }
  const commitVisitState = new Map<string, "active" | "complete">();
  const commitPath: string[] = [];
  const reportedCycles = new Set<string>();
  const visitCommit = (id: string): void => {
    const state = commitVisitState.get(id);
    if (state === "complete") return;
    if (state === "active") {
      const cycleStart = commitPath.indexOf(id);
      const cycle = commitPath.slice(cycleStart);
      const cycleKey = [...cycle].sort().join("\0");
      if (!reportedCycles.has(cycleKey)) {
        reportedCycles.add(cycleKey);
        error(
          "COMMIT_CYCLE",
          `Commit parent cycle detected: ${[...cycle, id].join(" -> ")}.`,
          [...cycle].sort()[0],
        );
      }
      return;
    }

    commitVisitState.set(id, "active");
    commitPath.push(id);
    for (const parent of commitsWithParents.get(id)!.parents) {
      if (commitsWithParents.has(parent)) visitCommit(parent);
    }
    commitPath.pop();
    commitVisitState.set(id, "complete");
  };
  for (const id of [...commitsWithParents.keys()].sort()) visitCommit(id);

  for (const branch of branches) {
    if (
      validateAgainstSchema("branch", branch).length > 0 ||
      !isRecord(branch) ||
      !isText(branch.name) ||
      !isText(branch.head) ||
      !isUtc(branch.createdAt) ||
      !isText(branch.author) ||
      (branch.tags !== undefined && !isTextArray(branch.tags)) ||
      (branch.metadata !== undefined && !isRecord(branch.metadata)) ||
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
    const nodeSchemaIssues = validateAgainstSchema("node", node);
    if (nodeSchemaIssues.length > 0) {
      error(
        "INVALID_NODE",
        `Node does not conform to its JSON schema: ${nodeSchemaIssues.join("; ")}.`,
        isRecord(node) && isText(node.id) ? node.id : undefined,
      );
      continue;
    }
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
