import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

const SCHEMA_FILES = [
  "aispec.schema.json",
  "node.schema.json",
  "commit.schema.json",
  "snapshot.schema.json",
  "branch.schema.json",
  "extension.schema.json",
] as const;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const schemaDirectory = [
  path.resolve(moduleDirectory, "..", "schemas"),
  path.resolve(moduleDirectory, "..", "..", "schemas"),
].find((directory) => existsSync(path.join(directory, "aispec.schema.json")));

if (!schemaDirectory) {
  throw new Error("AISpec JSON schemas could not be located");
}

const schemas = SCHEMA_FILES.map((filename) => {
  const contents = readFileSync(path.join(schemaDirectory, filename), "utf8");
  if (!contents.trim()) throw new Error(`AISpec JSON schema is empty: ${filename}`);
  return JSON.parse(contents) as object;
});

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);

const objectTypes = ["node", "snapshot", "commit", "branch", "extension"] as const;
export type SchemaObjectType = typeof objectTypes[number];

const schemaIds: Record<SchemaObjectType | "manifest", string> = {
  manifest: "urn:aispec:schema:aispec",
  node: "urn:aispec:schema:node",
  snapshot: "urn:aispec:schema:snapshot",
  commit: "urn:aispec:schema:commit",
  branch: "urn:aispec:schema:branch",
  extension: "urn:aispec:schema:extension",
};

const validators = Object.fromEntries(
  Object.entries(schemaIds).map(([type, id]) => {
    const validator = ajv.getSchema(id);
    if (!validator) throw new Error(`AISpec JSON schema failed to compile: ${type}`);
    return [type, validator];
  }),
) as Record<keyof typeof schemaIds, ValidateFunction>;

export function validateAgainstSchema(
  type: keyof typeof schemaIds,
  value: unknown,
): string[] {
  const validator = validators[type];
  if (validator(value)) return [];
  return (validator.errors ?? []).map((error) =>
    `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}

export function getSchema(type: keyof typeof schemaIds): object {
  const schema = ajv.getSchema(schemaIds[type])?.schema;
  return typeof schema === "object" && schema !== null ? schema : {};
}
