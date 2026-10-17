import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { stringify } from "yaml";

type Schema = Record<string, unknown> | boolean;

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "dist/cli.js");
const rootProfile = "https://example.test/profiles/root";
const basicSchema = {
  title: "Payload",
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};

function invoke(args: readonly string[], cwd = root): SpawnSyncReturns<string> {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

function success(result: SpawnSyncReturns<string>): void {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "restspec-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(schema: Schema = basicSchema) {
  const directory = await temporaryDirectory();
  const put = async (relativePath: string, value: unknown): Promise<string> => {
    const path = join(directory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : stringify(value));
    return path;
  };
  const spec = await put("restspec.yml", { url: "https://example.test/", rootProfile });
  await put("profiles/root.yml", {
    profile: rootProfile,
    schema: { "application/json": "../schemas/payload.json" },
    rels: {},
  });
  await put("schemas/payload.json", JSON.stringify(schema));
  const output = join(directory, "generated/types.ts");
  return {
    directory,
    spec,
    output,
    put,
    generate: () => invoke(["generate-types", spec, "--out", output]),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

test("generates all example types as deterministic, strict-compilable exports", async () => {
  const directory = await temporaryDirectory();
  const output = join(directory, "types.ts");
  const args = [
    "generate-types",
    join(root, "examples/checklist-api/restspec.yml"),
    "--out",
    output,
  ];
  success(invoke(args, tmpdir()));
  const types = await readFile(output, "utf8");
  for (const name of ["Root", "Checklist", "ChecklistInstance", "Subscription"]) {
    expect(types).toMatch(new RegExp(`export (?:interface|type) ${name}\\b`));
  }
  expect(types).toMatch(/checklistId:\s*(?:null \| string|string \| null);/);
  expect(types).toMatch(/completed:\s*(?:null \| Completed|Completed \| null);/);
  expect(types).toMatch(/note\?:\s*(?:null \| string|string \| null);/);
  expect(types).toMatch(/description\?:\s*string;/);
  expect(types).toMatch(/createdAt:\s*string;/);
  expect(types).toMatch(/"ACTIVE" \| "INACTIVE"/);
  expect(types).not.toMatch(/\b(?:Convert|Date|enum|function)\b/);
  expect(types.endsWith("\n")).toBe(true);
  expect(types).not.toContain("\r");
  success(invoke(args));
  expect(await readFile(output, "utf8")).toBe(types);

  const consumer = join(directory, "consumer.ts");
  await writeFile(consumer, `import type { Root, Checklist, ChecklistInstance, Subscription } from "./types.js";
export type Payloads = Root | Checklist | ChecklistInstance | Subscription;
export const nullableId: ChecklistInstance["checklistId"] = null;
export const timestamp: ChecklistInstance["createdAt"] = "2026-10-17T00:00:00Z";
`);
  const compiled = spawnSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--strict", "--noEmit", "--skipLibCheck", consumer,
  ], { encoding: "utf8" });
  expect(compiled.error).toBeUndefined();
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
});

test("discovers nested YAML profiles, includes unreachable profiles and deduplicates schemas", async () => {
  const project = await fixture();
  await project.put("profiles/nested/unreachable.yaml", {
    profile: "https://example.test/profiles/unreachable",
    schema: { "application/json": "../../schemas/other.json" },
  });
  await project.put("profiles/alias.yml", {
    profile: "https://example.test/profiles/alias",
    schema: { "application/json": "../schemas/payload.json" },
  });
  await project.put("profiles/xml.yml", {
    profile: "https://example.test/profiles/xml",
    schema: { "application/xml": "not-required.xsd" },
  });
  await project.put("schemas/other.json", JSON.stringify({ title: "Other", type: "boolean" }));
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  expect(types).toMatch(/export type Other = boolean;/);
  expect(types.match(/export interface Payload\b/g)).toHaveLength(1);
});

test("resolves local cross-file and internal refs with spaces in paths", async () => {
  const project = await fixture({
    title: "Payload",
    type: "object",
    required: ["external", "internal"],
    properties: {
      external: { $ref: "./with%20spaces/child.json#/$defs/Child" },
      internal: { $ref: "#/$defs/Label" },
    },
    $defs: { Label: { type: "string" } },
  });
  await project.put("schemas/with spaces/child.json", JSON.stringify({
    $defs: { Child: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } },
  }));
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  expect(types).toMatch(/internal:\s*string;/);
  expect(types).toMatch(/count:\s*number;/);
});

test.each<[label: string, schema: Schema, expected: RegExp]>([
  ["primitive", { title: "Value", type: "string" }, /export type Value = string;/],
  ["array", { title: "Value", type: "array", items: { type: "number" } }, /export type Value = number\[\];/],
  ["map", { title: "Value", type: "object", additionalProperties: { type: "boolean" } }, /export type Value = \{ \[key: string\]: boolean \};/],
  ["union", { title: "Value", oneOf: [{ type: "string" }, { type: "null" }] }, /export type Value = (?:null \| string|string \| null);/],
  ["unnamed", { type: "object", properties: { id: { type: "string" } } }, /export interface Payload\b/],
  ["boolean schema", true, /export type Payload = unknown;/],
])("exports a top-level %s schema", async (_label, schema, expected) => {
  const project = await fixture(schema);
  success(project.generate());
  expect(await readFile(project.output, "utf8")).toMatch(expected);
});

test.each<[label: string, change: (project: Fixture) => Promise<unknown>, expected: RegExp]>([
  ["missing root profile", (project) => project.put("restspec.yml", { url: "https://example.test/", rootProfile: "missing" }), /rootProfile missing has no local profile/],
  ["invalid main spec", (project) => project.put("restspec.yml", { rootProfile }), /url must be a nonempty string/],
  ["non-mapping spec", (project) => project.put("restspec.yml", "- invalid\n"), /expected a YAML mapping/],
  ["malformed YAML", (project) => project.put("profiles/root.yml", "profile: [\n"), /root\.yml:/],
  ["duplicate YAML keys", (project) => project.put("restspec.yml", "url: first\nurl: second\n"), /Map keys must be unique/],
  ["malformed JSON", (project) => project.put("schemas/payload.json", "{ invalid"), /payload\.json: invalid JSON/],
  ["invalid schema", (project) => project.put("schemas/payload.json", "[]"), /expected a JSON Schema object or boolean/],
  ["empty schema title", (project) => project.put("schemas/payload.json", JSON.stringify({ ...basicSchema, title: "" })), /schema title must be a nonempty string/],
  ["non-string schema title", (project) => project.put("schemas/payload.json", JSON.stringify({ ...basicSchema, title: 42 })), /schema title must be a nonempty string/],
  ["missing schema", (project) => rm(join(project.directory, "schemas/payload.json")), /ENOENT.*payload\.json/],
  ["missing profiles directory", (project) => rm(join(project.directory, "profiles"), { recursive: true }), /ENOENT.*profiles/],
  ["duplicate profile URI", (project) => project.put("profiles/duplicate.yml", { profile: rootProfile, schema: {} }), /duplicate profile URI/],
  ["invalid schema mapping", (project) => project.put("profiles/root.yml", { profile: rootProfile, schema: [] }), /schema must be a media-type mapping/],
  ["invalid schema path", (project) => project.put("profiles/root.yml", { profile: rootProfile, schema: { "application/json": 3 } }), /schema.application\/json must be a nonempty string/],
  ["no JSON schemas", (project) => project.put("profiles/root.yml", { profile: rootProfile, schema: {} }), /no application\/json schemas found/],
  ["remote reference", (project) => project.put("schemas/payload.json", JSON.stringify({ $ref: "https://example.invalid/schema.json" })), /Only local schema references are supported/],
])("reports %s without replacing existing output", async (_label, change, expected) => {
  const project = await fixture();
  await project.put("generated/types.ts", "existing output\n");
  await change(project);
  const result = project.generate();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(expected);
  expect(result.stderr).not.toMatch(/\n\s+at /);
  expect(await readFile(project.output, "utf8")).toBe("existing output\n");
});

test("rejects duplicate top-level names instead of silently losing a schema", async () => {
  const project = await fixture();
  await project.put("profiles/other.yml", {
    profile: "https://example.test/profiles/other",
    schema: { "application/json": "../schemas/other.json" },
  });
  await project.put("schemas/other.json", JSON.stringify(basicSchema));
  const result = project.generate();
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/duplicate schema type name Payload/);
});

test("protects input schemas reached through output symlinks", async () => {
  const project = await fixture();
  const schema = join(project.directory, "schemas/payload.json");
  const original = await readFile(schema, "utf8");
  const output = join(project.directory, "linked.ts");
  await symlink(schema, output);
  const result = invoke(["generate-types", project.spec, "--out", output]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/output would overwrite an input file/);
  expect(await readFile(schema, "utf8")).toBe(original);
});

test("retains distinct top-level names and filename fallbacks across schemas", async () => {
  const project = await fixture();
  await project.put("profiles/other.yml", {
    profile: "https://example.test/profiles/other",
    schema: { "application/json": "../schemas/other.json" },
  });
  await project.put("schemas/other.json", JSON.stringify({ ...basicSchema, title: "Other" }));
  await project.put("profiles/fallback.yml", {
    profile: "https://example.test/profiles/fallback",
    schema: { "application/json": "../schemas/fallback.schema.json" },
  });
  await project.put("schemas/fallback.schema.json", JSON.stringify({ type: "string" }));
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  expect(types).toMatch(/export interface Payload\b/);
  expect(types).toMatch(/export interface Other\b/);
  expect(types).toMatch(/export type FallbackSchema = string;/);
});

test("protects schemas consumed only through a reference", async () => {
  const project = await fixture({ title: "Payload", $ref: "./child.json" });
  const schema = await project.put("schemas/child.json", JSON.stringify(basicSchema));
  const original = await readFile(schema, "utf8");
  const output = join(project.directory, "linked.ts");
  await symlink(schema, output);
  const result = invoke(["generate-types", project.spec, "--out", output]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/output would overwrite an input file/);
  expect(await readFile(schema, "utf8")).toBe(original);
});

test("requires a .ts output file", async () => {
  const project = await fixture();
  const result = invoke(["generate-types", project.spec, "--out", join(project.directory, "types.json")]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/output must have a .ts extension/);
});

test("shows help and package version", async () => {
  const help = invoke(["--help"]);
  success(help);
  expect(help.stdout).toMatch(/Usage: restspec generate-types/);
  const version = invoke(["--version"]);
  success(version);
  const metadata: { version: string } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(version.stdout).toBe(`${metadata.version}\n`);
});

test.each([
  { args: [] },
  { args: ["unknown"] },
  { args: ["generate-types"] },
  { args: ["generate-types", "spec.yml"] },
  { args: ["generate-types", "spec.yml", "extra", "--out", "types.ts"] },
  { args: ["--unknown"] },
  { args: ["generate-types", "spec.yml", "--out", ""] },
])("rejects invalid invocation $args", ({ args }) => {
  const result = invoke(args);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/restspec:/);
  expect(result.stderr).not.toMatch(/\n\s+at /);
});