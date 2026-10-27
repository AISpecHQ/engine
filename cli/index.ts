#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { AISpecEngine } from "@aispechq/engine";

interface ParsedArguments {
  flags: Set<string>;
  options: Map<string, string[]>;
  positionals: string[];
}

interface CliFailure {
  code: string;
  message: string;
  exitCode: 2 | 3;
}

const GLOBAL_VALUE_OPTIONS = new Set(["--repo"]);
const GLOBAL_FLAGS = new Set(["--json"]);

function failure(code: string, message: string, exitCode: 2 | 3): CliFailure {
  return { code, message, exitCode };
}

function parseArguments(
  args: string[],
  allowedOptions: Set<string>,
  allowedFlags: Set<string> = new Set(),
): ParsedArguments {
  const flags = new Set<string>();
  const options = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
    if (GLOBAL_FLAGS.has(name) || allowedFlags.has(name)) {
      if (inlineValue !== undefined) {
        throw failure("INVALID_ARGUMENT", `${name} does not accept a value.`, 2);
      }
      flags.add(name);
      continue;
    }
    if (!GLOBAL_VALUE_OPTIONS.has(name) && !allowedOptions.has(name)) {
      throw failure("INVALID_ARGUMENT", `Unknown option: ${name}.`, 2);
    }

    const value = inlineValue ?? args[index + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
      throw failure("INVALID_ARGUMENT", `Option ${name} requires a value.`, 2);
    }
    if (!value.trim()) {
      throw failure("INVALID_ARGUMENT", `Option ${name} must not be empty.`, 2);
    }
    if (inlineValue === undefined) index += 1;
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }

  return { flags, options, positionals };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  const values = parsed.options.get(name) ?? [];
  if (values.length > 1) {
    throw failure("INVALID_ARGUMENT", `Option ${name} may be specified only once.`, 2);
  }
  return values[0];
}

function repeatedOptions(parsed: ParsedArguments, name: string): string[] {
  return parsed.options.get(name) ?? [];
}

function resolveRepositoryRoot(repoOption: string | undefined, cwd: string): string {
  const explicitRoot = repoOption ?? process.env.AISPEC_REPOSITORY;
  if (explicitRoot) {
    const root = path.resolve(cwd, explicitRoot);
    if (!existsSync(path.join(root, "aispec.yaml"))) {
      throw failure(
        "REPOSITORY_NOT_FOUND",
        `No AISpec repository found at ${root}.`,
        2,
      );
    }
    return root;
  }

  let directory = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(directory, "aispec.yaml"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw failure(
    "REPOSITORY_NOT_FOUND",
    "No AISpec repository found from the current directory upwards; use --repo or run aispec init.",
    2,
  );
}

function openRepository(repoOption: string | undefined, cwd: string): AISpecEngine {
  const root = resolveRepositoryRoot(repoOption, cwd);
  try {
    return AISpecEngine.open(root);
  } catch (cause) {
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }
}

function writeSuccess(data: unknown, json: boolean, message: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

function writeFailure(error: CliFailure, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: { code: error.code, message: error.message },
    })}\n`);
  } else {
    process.stderr.write(`aispec: ${error.message}\n`);
  }
}

function parseOptions(
  args: string[],
  commandOptions: string[],
): ParsedArguments {
  return parseArguments(
    args,
    new Set([...GLOBAL_VALUE_OPTIONS, ...commandOptions]),
    GLOBAL_FLAGS,
  );
}

function printHelp(): void {
  process.stdout.write(
    "AISpec Engine CLI (phases 1 and 2)\n\n" +
    "Usage:\n" +
    "  aispec init [<path>] --name <name> [--author <author>] [--version <semver>] [--json]\n" +
    "  aispec validate [--repo <path>] [--json]\n" +
    "  aispec inspect manifest [--repo <path>] [--json]\n" +
    "  aispec inspect <node|snapshot|commit|branch> <id-or-name> [--repo <path>] [--json]\n" +
    "  aispec snapshot <node-id> --config <file> [--repo <path>] [--json]\n" +
    "  aispec commit --message <message> --snapshot <id> [--snapshot <id> ...]\n" +
    "                --author <author> [--branch <name>] [--repo <path>] [--json]\n" +
    "  aispec branch list [--repo <path>] [--json]\n" +
    "  aispec branch create <name> --author <author> [--from <branch-or-commit>]\n" +
    "                      [--description <text>] [--repo <path>] [--json]\n" +
    "  aispec branch inspect <name-or-id> [--repo <path>] [--json]\n",
  );
}

function init(args: string[], cwd: string): number {
  const parsed = parseOptions(args, ["--name", "--author", "--version"]);
  if (parsed.options.has("--repo")) {
    throw failure("INVALID_ARGUMENT", "aispec init uses its optional positional target path, not --repo.", 2);
  }
  const name = option(parsed, "--name");
  if (!name?.trim()) {
    throw failure("INVALID_ARGUMENT", "aispec init requires --name <name>.", 2);
  }
  if (parsed.positionals.length > 1) {
    throw failure("INVALID_ARGUMENT", "aispec init accepts at most one target path.", 2);
  }

  const root = path.resolve(cwd, parsed.positionals[0] ?? ".");
  let targetInfo: ReturnType<typeof lstatSync> | undefined;
  try {
    targetInfo = lstatSync(root);
  } catch (cause) {
    if (
      typeof cause !== "object" || cause === null || !("code" in cause) ||
      cause.code !== "ENOENT"
    ) {
      throw cause;
    }
  }
  if (targetInfo) {
    const info = targetInfo;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw failure("TARGET_NOT_EMPTY", `Initialization target is not a regular directory: ${root}.`, 2);
    }
    if (readdirSync(root).length > 0) {
      throw failure(
        "TARGET_NOT_EMPTY",
        `Refusing to initialize a non-empty directory: ${root}.`,
        2,
      );
    }
  }

  let engine: AISpecEngine;
  try {
    engine = AISpecEngine.create(root, {
      name,
      ...(option(parsed, "--author") !== undefined
        ? { author: option(parsed, "--author") }
        : {}),
      ...(option(parsed, "--version") !== undefined
        ? { version: option(parsed, "--version") }
        : {}),
    });
    engine.saveRepository();
  } catch (cause) {
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }

  const data = { root: engine.root, manifest: engine.manifest };
  writeSuccess(data, parsed.flags.has("--json"), `Created AISpec repository "${name}" at ${engine.root}`);
  return 0;
}

function validate(args: string[], cwd: string): number {
  const parsed = parseOptions(args, []);
  if (parsed.positionals.length > 0) {
    throw failure("INVALID_ARGUMENT", "aispec validate does not accept positional arguments.", 2);
  }
  const engine = openRepository(option(parsed, "--repo"), cwd);
  let result;
  try {
    result = engine.validate();
  } catch (cause) {
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }

  const json = parsed.flags.has("--json");
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: result.valid, data: result })}\n`);
  } else if (result.valid) {
    process.stdout.write("Repository is valid.\n");
    for (const issue of result.issues) {
      process.stdout.write(`${issue.severity}: ${issue.code}: ${issue.message}\n`);
    }
  } else {
    process.stdout.write("Repository is invalid.\n");
    for (const issue of result.issues) {
      const object = issue.object ? ` [${issue.object}]` : "";
      process.stdout.write(`${issue.severity}: ${issue.code}${object}: ${issue.message}\n`);
    }
  }
  return result.valid ? 0 : 1;
}

function inspect(args: string[], cwd: string): number {
  const parsed = parseOptions(args, []);
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
    throw failure(
      "INVALID_ARGUMENT",
      "Usage: aispec inspect manifest | <node|snapshot|commit|branch> <id-or-name>.",
      2,
    );
  }
  const [kind, identifier] = parsed.positionals;
  const supported = new Set(["manifest", "node", "snapshot", "commit", "branch"]);
  if (!supported.has(kind!)) {
    throw failure("UNSUPPORTED_OBJECT_TYPE", `Cannot inspect unsupported object type "${kind}".`, 2);
  }
  if ((kind === "manifest" && identifier !== undefined) ||
      (kind !== "manifest" && identifier === undefined)) {
    throw failure("INVALID_ARGUMENT", `Invalid identifier for inspect ${kind}.`, 2);
  }

  const engine = openRepository(option(parsed, "--repo"), cwd);
  let value: unknown;
  try {
    switch (kind) {
      case "manifest":
        value = engine.manifest;
        break;
      case "node":
        value = engine.getNode(identifier!);
        break;
      case "snapshot":
        value = engine.getSnapshot(identifier!);
        break;
      case "commit":
        value = engine.getCommit(identifier!);
        break;
      case "branch":
        value = engine.getBranch(identifier!);
        break;
    }
  } catch (cause) {
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }

  if (!value) {
    throw failure(
      "OBJECT_NOT_FOUND",
      `No ${kind} object found${identifier === undefined ? "" : `: ${identifier}`}.`,
      2,
    );
  }
  writeSuccess(value, parsed.flags.has("--json"), JSON.stringify(value, null, 2));
  return 0;
}

function snapshot(args: string[], cwd: string): number {
  const parsed = parseOptions(args, ["--config"]);
  if (parsed.positionals.length !== 1) {
    throw failure(
      "INVALID_ARGUMENT",
      "Usage: aispec snapshot <node-id> --config <json-file>.",
      2,
    );
  }
  const nodeId = parsed.positionals[0]!;
  const configPath = option(parsed, "--config");
  if (!configPath) {
    throw failure("INVALID_ARGUMENT", "aispec snapshot requires --config <json-file>.", 2);
  }

  const engine = openRepository(option(parsed, "--repo"), cwd);
  let node;
  try {
    node = engine.getNode(nodeId);
  } catch (cause) {
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }
  if (!node) {
    throw failure("OBJECT_NOT_FOUND", `No node object found: ${nodeId}.`, 2);
  }

  const resolvedConfigPath = path.resolve(cwd, configPath);
  let text: string;
  try {
    text = readFileSync(resolvedConfigPath, "utf8");
  } catch (cause) {
    if (isNodeErrorWithCode(cause, "ENOENT")) {
      throw failure(
        "CONFIG_NOT_FOUND",
        `Configuration file not found: ${resolvedConfigPath}.`,
        2,
      );
    }
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }

  let configuration: unknown;
  try {
    configuration = JSON.parse(text);
  } catch {
    throw failure(
      "INVALID_CONFIG_JSON",
      `Configuration file is not valid JSON: ${resolvedConfigPath}.`,
      2,
    );
  }
  if (!isJsonObject(configuration)) {
    throw failure(
      "INVALID_CONFIGURATION",
      "Snapshot configuration must be a JSON object.",
      2,
    );
  }

  let created;
  try {
    created = engine.createSnapshot({ nodeId, configuration });
    engine.saveRepository();
  } catch (cause) {
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }
  writeSuccess(
    created,
    parsed.flags.has("--json"),
    `Created snapshot ${created.id} for node ${nodeId}.`,
  );
  return 0;
}

function commit(args: string[], cwd: string): number {
  const parsed = parseOptions(args, ["--message", "--snapshot", "--author", "--branch"]);
  if (parsed.positionals.length > 0) {
    throw failure("INVALID_ARGUMENT", "aispec commit does not accept positional arguments.", 2);
  }
  const message = option(parsed, "--message");
  const author = option(parsed, "--author");
  const branchName = option(parsed, "--branch") ?? "main";
  const snapshotIds = repeatedOptions(parsed, "--snapshot");
  if (!message?.trim()) {
    throw failure("INVALID_ARGUMENT", "aispec commit requires --message <message>.", 2);
  }
  if (!author?.trim()) {
    throw failure(
      "INVALID_ARGUMENT",
      "aispec commit requires --author <author>. Example: aispec commit --message \"Save state\" --snapshot <id> --author \"Ada\".",
      2,
    );
  }
  if (snapshotIds.length === 0) {
    throw failure("INVALID_ARGUMENT", "aispec commit requires at least one --snapshot <id>.", 2);
  }

  const engine = openRepository(option(parsed, "--repo"), cwd);
  let branch;
  let missingSnapshot: string | undefined;
  try {
    branch = engine.getBranch(branchName);
    for (const id of snapshotIds) {
      if (!engine.getSnapshot(id)) {
        missingSnapshot = id;
        break;
      }
    }
  } catch (cause) {
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }
  if (!branch) {
    throw failure("OBJECT_NOT_FOUND", `No branch object found: ${branchName}.`, 2);
  }
  if (missingSnapshot) {
    throw failure("OBJECT_NOT_FOUND", `No snapshot object found: ${missingSnapshot}.`, 2);
  }

  let created;
  try {
    created = engine.createCommit({
      message,
      author,
      branch: branchName,
      snapshotIds,
    });
    engine.saveRepository();
  } catch (cause) {
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }
  writeSuccess(
    created,
    parsed.flags.has("--json"),
    `Created commit ${created.id} on branch ${created.branch} with ${created.snapshotIds.length} snapshot(s).`,
  );
  return 0;
}

function branchCommand(args: string[], cwd: string): number {
  const [action, ...actionArgs] = args;
  if (action !== "list" && action !== "create" && action !== "inspect") {
    throw failure(
      "INVALID_ARGUMENT",
      "Usage: aispec branch list | create <name> --author <author> | inspect <name-or-id>.",
      2,
    );
  }

  if (action === "list") {
    const parsed = parseOptions(actionArgs, []);
    if (parsed.positionals.length > 0) {
      throw failure("INVALID_ARGUMENT", "aispec branch list takes no positional arguments.", 2);
    }
    const engine = openRepository(option(parsed, "--repo"), cwd);
    let branches;
    try {
      branches = engine.listBranches();
    } catch (cause) {
      throw failure(
        "ENGINE_ERROR",
        cause instanceof Error ? cause.message : String(cause),
        3,
      );
    }
    writeSuccess(
      branches,
      parsed.flags.has("--json"),
      branches.length === 0
        ? "No branches."
        : branches.map((item) => `${item.name} (${item.id}) HEAD ${item.head}`).join("\n"),
    );
    return 0;
  }

  if (action === "inspect") {
    const parsed = parseOptions(actionArgs, []);
    if (parsed.positionals.length !== 1) {
      throw failure("INVALID_ARGUMENT", "Usage: aispec branch inspect <name-or-id>.", 2);
    }
    const nameOrId = parsed.positionals[0]!;
    const engine = openRepository(option(parsed, "--repo"), cwd);
    let found;
    try {
      found = engine.getBranch(nameOrId);
    } catch (cause) {
      throw failure(
        "ENGINE_ERROR",
        cause instanceof Error ? cause.message : String(cause),
        3,
      );
    }
    if (!found) {
      throw failure("OBJECT_NOT_FOUND", `No branch object found: ${nameOrId}.`, 2);
    }
    writeSuccess(
      found,
      parsed.flags.has("--json"),
      `${found.name} (${found.id}) HEAD ${found.head}`,
    );
    return 0;
  }

  const parsed = parseOptions(actionArgs, ["--author", "--from", "--description"]);
  if (parsed.positionals.length !== 1) {
    throw failure("INVALID_ARGUMENT", "Usage: aispec branch create <name> --author <author>.", 2);
  }
  const name = parsed.positionals[0]!;
  const author = option(parsed, "--author");
  const from = option(parsed, "--from");
  const description = option(parsed, "--description");
  if (!author?.trim()) {
    throw failure(
      "INVALID_ARGUMENT",
      "aispec branch create requires --author <author>. Example: aispec branch create feature/example --author \"Ada\".",
      2,
    );
  }

  const engine = openRepository(option(parsed, "--repo"), cwd);
  let duplicate: boolean;
  let sourceExists: boolean;
  try {
    duplicate = Boolean(engine.getBranch(name));
    sourceExists = from === undefined
      ? Boolean(engine.getBranch("main"))
      : Boolean(engine.getBranch(from) ?? engine.getCommit(from));
  } catch (cause) {
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }
  if (duplicate) {
    throw failure("BRANCH_ALREADY_EXISTS", `Branch already exists: ${name}.`, 3);
  }
  if (!sourceExists) {
    throw failure(
      "OBJECT_NOT_FOUND",
      `Branch or commit not found: ${from ?? "main"}.`,
      2,
    );
  }

  let created;
  try {
    created = engine.createBranch({
      name,
      author,
      ...(from !== undefined ? { from } : {}),
      ...(description !== undefined ? { description } : {}),
    });
    engine.saveRepository();
  } catch (cause) {
    throw failure(
      "ENGINE_ERROR",
      cause instanceof Error ? cause.message : String(cause),
      3,
    );
  }
  writeSuccess(
    created,
    parsed.flags.has("--json"),
    `Created branch ${created.name} (${created.id}) at HEAD ${created.head}.`,
  );
  return 0;
}

function isNodeErrorWithCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null &&
    "code" in value && value.code === code;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dispatch(args: string[], cwd: string): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }

  const [command, ...commandArgs] = args;
  switch (command) {
    case "init":
      return init(commandArgs, cwd);
    case "validate":
      return validate(commandArgs, cwd);
    case "inspect":
      return inspect(commandArgs, cwd);
    case "snapshot":
      return snapshot(commandArgs, cwd);
    case "commit":
      return commit(commandArgs, cwd);
    case "branch":
      return branchCommand(commandArgs, cwd);
    default:
      throw failure(
        "INVALID_ARGUMENT",
        `Unknown command "${command}". Run aispec --help for usage.`,
        2,
      );
  }
}

export function runCli(args: string[], cwd = process.cwd()): number {
  const wantsJson = args.includes("--json");
  try {
    return dispatch(args, cwd);
  } catch (cause) {
    const error: CliFailure = isCliFailure(cause)
      ? cause
      : failure(
        "ENGINE_ERROR",
        cause instanceof Error ? cause.message : String(cause),
        3,
      );
    writeFailure(error, wantsJson);
    return error.exitCode;
  }
}

function isCliFailure(value: unknown): value is CliFailure {
  return typeof value === "object" && value !== null &&
    "code" in value && "message" in value && "exitCode" in value;
}

process.exitCode = runCli(process.argv.slice(2));
