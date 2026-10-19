import { execFile, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  await mkdir(join(directory, "node_modules"));
  await symlink(root, join(directory, "node_modules/restspec"), "dir");
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
  const spec = await put("restspec.yml", {
    env: {
      staging: {
        url: "https://staging.example.test/",
        description: "Staging environment.",
      },
      production: {
        url: "https://example.test/",
      },
    },
    rootProfile,
  });
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

test("resource wrapper nests payload properties without wrapping nested objects", async () => {
  const project = await fixture({
    ...basicSchema,
    properties: {
      id: { type: "string" },
      nested: {
        type: "object", properties: { count: { type: "integer" } },
        required: ["count"], additionalProperties: false,
      },
    },
    required: ["id", "nested"],
  });
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  expect(types).toMatch(/export interface Payload \{\s+properties: \{\s+id: string;\s+nested: \{\s+count: number;/);
  expect(types.match(/export interface /g)).toHaveLength(1);
  expect(types).toContain("getRel<METHODS extends Methods>(rel: string): Link<METHODS>[];");
  expect(types).toContain("get rels(): {");
});

test.each([false, true])("inlines schema properties while retaining recursive references (nullable: %s)", async (nullable) => {
  const node = {
    type: "object",
    properties: {
      value: { type: "string" },
      children: { type: "array", items: { $ref: "#" } },
    },
    required: ["value", "children"],
    additionalProperties: false,
  };
  const project = await fixture(nullable
    ? { title: "Node", anyOf: [{ type: "null" }, node] }
    : { title: "Node", ...node });
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  expect(types).toMatch(/properties:\s*(?:null \| )?\{/);
  const consumer = await project.put("consumer.ts", `import type { Node } from "./generated/types.js";
export const tree: Node["properties"] = { value: "root", children: [{ value: "leaf", children: [] }] };
`);
  const compiled = spawnSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--strict", "--noEmit", "--skipLibCheck", consumer,
  ], { encoding: "utf8" });
  expect(compiled.error).toBeUndefined();
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
});

test("getRel uses caller-supplied Methods and returns typed Link arrays", async () => {
  const project = await fixture();
  const childProfile = "https://example.test/profiles/child";
  await project.put("profiles/root.yml", {
    profile: rootProfile,
    schema: { "application/json": "../schemas/payload.json" },
    rels: {
      related: [{ name: "child", profile: childProfile }, { name: "external", profile: "urn:external" }],
      create: [{ name: "child", profile: childProfile }],
      "create-from": [{ name: "child", profile: childProfile }],
      "urn:custom": [{ name: "self", profile: rootProfile }],
      empty: [],
    },
  });
  await project.put("profiles/child.yml", {
    profile: childProfile,
    schema: { "application/json": "../schemas/child.json" },
    rels: { related: [{ name: "parent", profile: rootProfile }] },
  });
  await project.put("schemas/child.json", JSON.stringify({ title: "Child", type: "string" }));
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  expect(types.match(/getRel<METHODS extends Methods>\(rel: string\): Link<METHODS>\[\];/g)).toHaveLength(2);
  expect(types).toContain("get rels(): {");
  const consumer = await project.put("consumer.ts", `import type { Link, Methods } from "restspec";
import type { Payload, Child } from "./generated/types.js";
declare const resource: Payload;
export const properties: string = resource.properties.id;
export const namedChild: Promise<Child> = resource.rels.related.child.request.get();
export const namedParent: Promise<Payload> = ({} as Child).rels.related.parent.request.get();
export const namedExternal: Promise<unknown> = resource.rels.related.external.request.get();
export const namedCustom: Promise<Payload> = resource.rels["urn:custom"].self.request.get();
export const namedCreate = resource.rels["create-from"].child.request.post({ label: "child" });
// @ts-expect-error Unknown link names are not exposed.
resource.rels.related.missing;
// @ts-expect-error Unknown relations are not exposed.
resource.rels.missing;
// @ts-expect-error Named links are getters.
resource.rels.related.child = resource.rels.related.child;
// @ts-expect-error The relationship index is a getter.
resource.rels = resource.rels;
// @ts-expect-error Local target response types are preserved.
const incorrectTarget: Promise<Payload> = resource.rels.related.child.request.get();
type CreateMethods = { post: [{ label: string }, Child] };
export const links: Link<CreateMethods>[] = resource.getRel<CreateMethods>("create-from");
export const name: string | undefined = links[0].name;
export const title: string | undefined = links[0].title;
export const created: Promise<Child> = links[0].request.post({ label: "child" });
export const parent: Promise<Payload> = ({} as Child).getRel<{ get: [void, Payload] }>("related")[0].request.get();
export const custom: Link<Methods>[] = resource.getRel<Methods>("urn:custom");
export const unspecified: Link<Methods>[] = resource.getRel("not-in-the-spec");
declare const defaults: Link;
export const defaultGet: Promise<unknown> = defaults.request.get({});
export const defaultPost: Promise<unknown> = defaults.request.post("body");
export const defaultPut: Promise<unknown> = links[0].request.put({});
export const defaultPatch: Promise<unknown> = defaults.request.patch(null);
export const defaultDelete: Promise<unknown> = defaults.request.delete(undefined);
export const defaultHead: Promise<unknown> = unspecified[0].request.head(undefined);
export const defaultOptions: Promise<unknown> = defaults.request.options({});
declare const customMethod: Link<{ search: [{ query: string }, Child] }>;
export const searched: Promise<Child> = customMethod.request.search({ query: "child" });
`);
  const compiled = spawnSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--strict", "--noEmit", "--skipLibCheck", consumer,
  ], { encoding: "utf8" });
  expect(compiled.error).toBeUndefined();
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  await project.put("consumer.ts", `import type { Link } from "restspec";
import type { Payload } from "./generated/types.js";
declare const resource: Payload;
resource.getRel<{ get: string }>("related");
declare const request: Link<{ get: [void, string] }>["request"];
const missingMetadata: Link<{ get: [void, string] }> = { request };
declare const link: Link<{ get: [void, string] }>;
link.get();
link.request.get("invalid body");
declare const defaults: Link;
const wrongDefault: Promise<string> = defaults.request.get({});
const wrongInferredDefault: Promise<string> = resource.getRel("related")[0].request.post({});
const wrongBody: string = {} as Parameters<typeof defaults.request.post>[0];
resource.getRel<{ post: [{ label: string }, Payload] }>("create")[0].request.post({ label: 123 });
`);
  const invalid = spawnSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--strict", "--noEmit", "--skipLibCheck", consumer,
  ], { encoding: "utf8" });
  expect(invalid.error).toBeUndefined();
  expect(invalid.status).not.toBe(0);
  expect(invalid.stdout).toContain("does not satisfy the constraint 'Methods'");
  expect(invalid.stdout).toContain("href");
  expect(invalid.stdout).toContain("Property 'get' does not exist");
  expect(invalid.stdout).toContain("Argument of type 'string' is not assignable to parameter of type 'void'");
  expect(invalid.stdout).toContain("Type 'Promise<unknown>' is not assignable to type 'Promise<string>'");
  expect(invalid.stdout).toContain("Type 'unknown' is not assignable to type 'string'");
  expect(invalid.stdout).toContain("Type 'number' is not assignable to type 'string'");
});

test("root export uses the generated root schema type name", async () => {
  const project = await fixture({ ...basicSchema, title: "Root payload" });
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  expect(types).toContain('import type { ApiRoot, Link, Methods } from "restspec";');
  expect(types).toContain("export interface RootPayload");
  expect(types).toContain("export const root: ApiRoot<RootPayload, { staging: string; production: string; }> = {");
  expect(types).toContain(`    env: {
        /**
         * Staging environment.
         */
        staging: "https://staging.example.test/",
        production: "https://example.test/",
    },`);
  expect(types).toContain(`profile: ${JSON.stringify(rootProfile)},`);
});

test.each([
  { title: "Scalar payload", type: "string", name: "ScalarPayload" },
  { title: "Array payload", type: "array", items: { type: "string" }, name: "ArrayPayload" },
])("root export references a wrapped $type payload", async ({ name, ...schema }) => {
  const project = await fixture(schema);
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  expect(types).toContain(`export interface ${name} {`);
  expect(types).toContain(`export const root: ApiRoot<${name}, { staging: string; production: string; }> = {`);
});

test("root export follows its profile rather than discovery order and shares schema types", async () => {
  const project = await fixture();
  await project.put("profiles/aaa.yml", {
    profile: "https://example.test/profiles/first",
    schema: { "application/json": "../schemas/first.json" },
  });
  await project.put("schemas/first.json", JSON.stringify({ title: "First", type: "boolean" }));
  await project.put("profiles/alias.yml", {
    profile: "https://example.test/profiles/alias",
    schema: { "application/json": "../schemas/payload.json" },
    rels: { related: [{ name: "root", profile: rootProfile }] },
  });
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  expect(types).toMatch(/export interface First \{\s+properties:\s*boolean;/);
  expect(types.match(/export interface Payload\b/g)).toHaveLength(1);
  expect(types).toContain("export const root: ApiRoot<Payload, { staging: string; production: string; }> = {");
  expect(types.match(/getRel<METHODS extends Methods>/g)).toHaveLength(2);
  expect(types).toContain('get "root"(): Link<{ get: [void, Payload] }>;');
});

test("root export falls back to unknown without a root JSON schema", async () => {
  const project = await fixture();
  await project.put("profiles/root.yml", { profile: rootProfile, schema: {} });
  await project.put("profiles/other.yml", {
    profile: "https://example.test/profiles/other",
    schema: { "application/json": "../schemas/payload.json" },
  });
  success(project.generate());
  expect(await readFile(project.output, "utf8")).toContain("export const root: ApiRoot<unknown, { staging: string; production: string; }> = {");
});

test("root export uses deconflicted schema identifiers", async () => {
  const project = await fixture({ ...basicSchema, title: "Root payload" });
  await project.put("profiles/other.yml", {
    profile: "https://example.test/profiles/other",
    schema: { "application/json": "../schemas/other.json" },
  });
  await project.put("schemas/other.json", JSON.stringify({
    title: "root-payload", type: "object", properties: { count: { type: "number" } }, required: ["count"],
  }));
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  const name = types.match(/export interface (\w+) \{\s+properties: \{\s+id:/)?.[1];
  expect(name).toBeDefined();
  expect(types).toContain(`export const root: ApiRoot<${name}, { staging: string; production: string; }> = {`);
});

test.each(["ApiRoot", "ENV", "Link", "Methods"])("root export handles the %s type name and preserves escaped values", async (title) => {
  const project = await fixture({ ...basicSchema, title });
  const env = {
    staging: 'https://staging.example.test/"\\\n',
    "prod-env\"\\\n": 'https://example.test/"\\\n',
  };
  const profile = 'https://example.test/profiles/"\\\n';
  await project.put("restspec.yml", {
    env: {
      staging: { url: env.staging, description: 'Staging */ "\\\nSecond line' },
      "prod-env\"\\\n": { url: env["prod-env\"\\\n"] },
    },
    rootProfile: profile,
  });
  await project.put("profiles/root.yml", {
    profile, schema: { "application/json": "../schemas/payload.json" },
  });
  success(project.generate());
  const types = await readFile(project.output, "utf8");
  const name = types.match(/export interface (\w+)/)?.[1];
  expect(name).toBeDefined();
  expect(name).not.toBe("ApiRoot");
  expect(name).not.toBe("ENV");
  expect(name).not.toBe("Link");
  expect(name).not.toBe("Methods");
  expect(types).toContain(`export const root: ApiRoot<${name}, { staging: string; ${JSON.stringify("prod-env\"\\\n")}: string; }> = {`);
  expect(types).toContain(`        /**
         * Staging * / "\\
         * Second line
         */
        staging:`);
  const compiled = spawnSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--strict", "--skipLibCheck", "--module", "ES2022", "--moduleResolution", "node",
    "--outDir", join(project.directory, "compiled"), project.output,
  ], { encoding: "utf8" });
  expect(compiled.error).toBeUndefined();
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  const javascript = await readFile(join(project.directory, "compiled/types.js"), "utf8");
  expect(javascript).not.toContain("restspec");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
  const loaded = spawnSync(process.execPath, [
    "--input-type=module", "--eval",
    `import { root } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(root));`,
  ], { encoding: "utf8" });
  success(loaded);
  expect(JSON.parse(loaded.stdout)).toEqual({ env, profile });
});

test("root export resolves ApiRoot from the packed package", async () => {
  const project = await fixture();
  success(project.generate());
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", project.directory], {
    cwd: root, encoding: "utf8", timeout: 20_000,
  });
  expect(packed.error).toBeUndefined();
  expect(packed.status, packed.stdout + packed.stderr).toBe(0);
  const packages: { filename: string }[] = JSON.parse(packed.stdout);
  expect(packages).toHaveLength(1);
  const packageDirectory = join(project.directory, "node_modules/restspec");
  await rm(packageDirectory);
  await mkdir(packageDirectory);
  const extracted = spawnSync("tar", [
    "-xzf", join(project.directory, packages[0]!.filename),
    "--strip-components=1", "-C", packageDirectory,
  ], { encoding: "utf8" });
  success(extracted);
  await project.put("package.json", { type: "module" });
  const consumer = await project.put("consumer.ts", `import { fromHref, fromRoot } from "restspec";
import type { ApiRoot, Link } from "restspec";
import { root } from "./generated/types.js";
import type { Payload } from "./generated/types.js";
export const entry: ApiRoot<Payload, { staging: string; production: string }> = root;
export const genericEntry: ApiRoot<Payload> = root;
const inferred = fromRoot(root, "staging");
export const productionLink: Link<{ get: [void, Payload] }> = fromRoot(root, "production");
export const authenticatedRoot: Link<{ get: [void, Payload] }> = fromRoot(root, "staging", {
  credentials: { type: "bearer", token: "example-token" },
});
export const mappedRoot = fromRoot(root, "staging", {
  credentials: { "https://example.test": { type: "bearer", token: "example-token" } },
});
export const authenticatedBookmark: Link<{ get: [void, Payload] }> = fromHref<Payload>(root.env.staging, {
  credentials: { type: "bearer", token: "example-token" },
});
export const mappedBookmark = fromHref(root.env.staging, {
  credentials: { "example.test": { type: "bearer", token: "example-token" } },
});
// @ts-expect-error Bearer credentials require a token.
fromRoot(root, "staging", { credentials: { type: "bearer" } });
// @ts-expect-error Credential tokens must be strings.
fromHref(root.env.staging, { credentials: { "example.test": { type: "bearer", token: 123 } } });
// @ts-expect-error Unsupported credential schemes are rejected.
fromHref(root.env.staging, { credentials: { type: "basic", token: "example-token" } });
// @ts-expect-error Environment argument is required.
fromRoot(root);
// @ts-expect-error Only defined environment keys are accepted.
fromRoot(root, "unknown");
// @ts-expect-error ApiRoot requires an env record.
const missingEnv: ApiRoot<Payload> = { profile: root.profile };
// @ts-expect-error ApiRoot env values must be strings.
const nonStringEnv: ApiRoot<Payload, { staging: number }> = { env: { staging: 123 }, profile: root.profile };
export const entryLink: Link<{ get: [void, Payload] }> = inferred;
export const name: string | undefined = inferred.name;
export const title: string | undefined = inferred.title;
export const href: string = inferred.href;
// @ts-expect-error Link href is read-only.
inferred.href = "https://api.example.com/other";
export const result: Promise<Payload> = inferred.request.get();
export async function readRoot(): Promise<Payload> {
  const resource = await inferred.request.get();
  const id: string = resource.properties.id;
  return resource;
}
declare const resource: Payload;
export const links: Link<{ get: [void, Payload] }>[] = resource.getRel<{ get: [void, Payload] }>("related");
const bookmarked = fromHref<Payload>("https://api.example.com/resources/123");
export const bookmarkLink: Link<{ get: [void, Payload] }> = bookmarked;
export const bookmarkName: string | undefined = bookmarked.name;
export const bookmarkTitle: string | undefined = bookmarked.title;
export const bookmarkHref: string = bookmarked.href;
export const bookmarkResult: Promise<Payload> = bookmarked.request.get();
export async function readBookmark(): Promise<Payload> {
  const resource = await bookmarked.request.get();
  const id: string = resource.properties.id;
  return resource;
}
// @ts-expect-error Bookmarks must be strings.
fromHref<Payload>(123);
// @ts-expect-error GET returns the specified resource type.
export const invalidBookmarkResult: Promise<string> = bookmarked.request.get();
const untypedBookmark = fromHref("https://api.example.com/resources/123");
export const unknownBookmarkResult: Promise<unknown> = untypedBookmark.request.get();
// @ts-expect-error An omitted resource type cannot imply Payload.
export const invalidUntypedBookmarkResult: Promise<Payload> = untypedBookmark.request.get();
`);
  for (const [module, resolution] of [["NodeNext", "NodeNext"], ["ES2022", "node"]]) {
    const compiled = spawnSync(process.execPath, [
      join(root, "node_modules/typescript/bin/tsc"),
      "--strict", "--noEmit", "--skipLibCheck", "--module", module!,
      "--moduleResolution", resolution!, consumer,
    ], { encoding: "utf8" });
    expect(compiled.error).toBeUndefined();
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  }
}, 20_000);

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
  expect(types).toMatch(/completed:\s*(?:null \| )?\{/);
  expect(types).toMatch(/note\?:\s*(?:null \| string|string \| null);/);
  expect(types).toMatch(/description\?:\s*string;/);
  expect(types).toMatch(/createdAt:\s*string;/);
  expect(types).toMatch(/"ACTIVE" \| "INACTIVE"/);
  expect(types.match(/export interface /g)).toHaveLength(4);
  expect(types).not.toMatch(/\b(?:FluffyItem|PurpleItem|Completed|Status)\b/);
  expect(types).not.toMatch(/\b(?:Convert|Date|enum|function)\b/);
  expect(types.endsWith("\n")).toBe(true);
  expect(types).not.toContain("\r");
  success(invoke(args));
  expect(await readFile(output, "utf8")).toBe(types);

  const consumer = join(directory, "consumer.ts");
  await writeFile(consumer, `import { fromRoot } from "restspec";
import type { ApiRoot } from "restspec";
import { root } from "./types.js";
import type { Root, Checklist, ChecklistInstance, Subscription } from "./types.js";
export const entry: ApiRoot<Root, { local: string; staging: string; production: string }> = root;
export const localUrl: string = root.env.local;
export const stagingUrl: string = root.env.staging;
export const productionUrl: string = root.env.production;
export const profile: string = root.profile;
export type Payloads = Root | Checklist | ChecklistInstance | Subscription;
export const nullableId: ChecklistInstance["properties"]["checklistId"] = null;
export const timestamp: ChecklistInstance["properties"]["createdAt"] = "2026-10-17T00:00:00Z";
declare const resource: Root;
export const related = resource.getRel<{ get: [void, Subscription] }>("related");
export const created = resource.getRel<{ post: [unknown, Checklist] }>("create");
export async function typeSafeAccess() {
  const resource = await fromRoot(root, "local").request.get();
  await resource.rels.related.checklists.request.post({ title: "My New Checklist" });
  const subscription: Subscription = await resource.rels.related.subscription.request.get();
  const checklist: Checklist = await resource.rels.create.checklists.request.get();
  const instance: ChecklistInstance = await checklist.rels["create-from"].instance.request.get();
  return { subscription, instance };
}
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
  expect(types).toMatch(/export interface Other \{\s+properties:\s*boolean;/);
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
  ["primitive", { title: "Value", type: "string" }, /properties:\s*string;/],
  ["array", { title: "Value", type: "array", items: { type: "number" } }, /properties:\s*number\[\];/],
  ["map", { title: "Value", type: "object", additionalProperties: { type: "boolean" } }, /properties:\s*\{ \[key: string\]: boolean \};/],
  ["union", { title: "Value", oneOf: [{ type: "string" }, { type: "null" }] }, /properties:\s*(?:null \| string|string \| null);/],
  ["unnamed", { type: "object", properties: { id: { type: "string" } } }, /export interface Payload\b/],
  ["boolean schema", true, /properties:\s*unknown;/],
])("exports a top-level %s schema", async (_label, schema, expected) => {
  const project = await fixture(schema);
  success(project.generate());
  expect(await readFile(project.output, "utf8")).toMatch(expected);
});

test.each<[label: string, change: (project: Fixture) => Promise<unknown>, expected: RegExp]>([
  ["missing root profile", (project) => project.put("restspec.yml", { env: { production: { url: "https://example.test/" } }, rootProfile: "missing" }), /rootProfile missing has no local profile/],
  ["invalid main spec", (project) => project.put("restspec.yml", { rootProfile }), /env must be a nonempty environment mapping/],
  ["legacy single url spec", (project) => project.put("restspec.yml", { url: "https://example.test/", rootProfile }), /env must be a nonempty environment mapping/],
  ["non-mapping env", (project) => project.put("restspec.yml", { env: ["https://example.test/"], rootProfile }), /env must be a nonempty environment mapping/],
  ["empty env mapping", (project) => project.put("restspec.yml", { env: {}, rootProfile }), /env must be a nonempty environment mapping/],
  ["blank env key", (project) => project.put("restspec.yml", { env: { "   ": { url: "https://example.test/" } }, rootProfile }), /env key must be a nonempty string/],
  ["non-mapping env entry", (project) => project.put("restspec.yml", { env: { staging: "https://example.test/" }, rootProfile }), /env\.staging must be a mapping/],
  ["missing env url", (project) => project.put("restspec.yml", { env: { staging: { description: "Staging" } }, rootProfile }), /env\.staging\.url must be a nonempty string/],
  ["invalid env url", (project) => project.put("restspec.yml", { env: { staging: { url: "" } }, rootProfile }), /env\.staging\.url must be a nonempty string/],
  ["non-string env url", (project) => project.put("restspec.yml", { env: { staging: { url: 123 } }, rootProfile }), /env\.staging\.url must be a nonempty string/],
  ["empty env description", (project) => project.put("restspec.yml", { env: { staging: { url: "https://example.test/", description: "   " } }, rootProfile }), /env\.staging\.description must be a nonempty string/],
  ["non-string env description", (project) => project.put("restspec.yml", { env: { staging: { url: "https://example.test/", description: 123 } }, rootProfile }), /env\.staging\.description must be a nonempty string/],
  ["non-mapping spec", (project) => project.put("restspec.yml", "- invalid\n"), /expected a YAML mapping/],
  ["malformed YAML", (project) => project.put("profiles/root.yml", "profile: [\n"), /root\.yml:/],
  ["duplicate YAML keys", (project) => project.put("restspec.yml", "env:\n  staging:\n    url: first\n  staging:\n    url: second\n"), /Map keys must be unique/],
  ["malformed JSON", (project) => project.put("schemas/payload.json", "{ invalid"), /payload\.json: invalid JSON/],
  ["invalid schema", (project) => project.put("schemas/payload.json", "[]"), /expected a JSON Schema object or boolean/],
  ["empty schema title", (project) => project.put("schemas/payload.json", JSON.stringify({ ...basicSchema, title: "" })), /schema title must be a nonempty string/],
  ["non-string schema title", (project) => project.put("schemas/payload.json", JSON.stringify({ ...basicSchema, title: 42 })), /schema title must be a nonempty string/],
  ["missing schema", (project) => rm(join(project.directory, "schemas/payload.json")), /ENOENT.*payload\.json/],
  ["missing profiles directory", (project) => rm(join(project.directory, "profiles"), { recursive: true }), /ENOENT.*profiles/],
  ["duplicate profile URI", (project) => project.put("profiles/duplicate.yml", { profile: rootProfile, schema: {} }), /duplicate profile URI/],
  ["invalid schema mapping", (project) => project.put("profiles/root.yml", { profile: rootProfile, schema: [] }), /schema must be a media-type mapping/],
  ["invalid schema path", (project) => project.put("profiles/root.yml", { profile: rootProfile, schema: { "application/json": 3 } }), /schema.application\/json must be a nonempty string/],
  ["invalid relations", (project) => project.put("profiles/root.yml", { profile: rootProfile, rels: [] }), /rels must be a relation-type mapping/],
  ["invalid relation array", (project) => project.put("profiles/root.yml", { profile: rootProfile, rels: { related: {} } }), /rels.related must be an array/],
  ["invalid relation entry", (project) => project.put("profiles/root.yml", { profile: rootProfile, rels: { related: ["invalid"] } }), /rels.related entries must be mappings/],
  ["missing relation target", (project) => project.put("profiles/root.yml", { profile: rootProfile, rels: { related: [{}] } }), /rels.related.profile must be a nonempty string/],
  ["invalid relation name", (project) => project.put("profiles/root.yml", { profile: rootProfile, rels: { related: [{ name: 123, profile: rootProfile }] } }), /rels.related.name must be a nonempty string/],
  ["no JSON schemas", (project) => project.put("profiles/root.yml", { profile: rootProfile, schema: {} }), /no application\/json schemas found/],
  ["http schema reference", (project) => project.put("schemas/payload.json", JSON.stringify({ $ref: "http://example.invalid/schema.json" })), /Only file: and https: schema references are supported/],
  ["unreachable https schema reference", (project) => project.put("schemas/payload.json", JSON.stringify({ $ref: "https://127.0.0.1:1/schema.json" })), /Could not fetch schema https:\/\/127\.0\.0\.1:1\/schema\.json/],
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
  expect(types).toMatch(/export interface FallbackSchema \{\s+properties:\s*string;/);
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

test.each(["--profiles", "-p"])("reads profiles from a custom directory with %s", async (flag) => {
  const project = await fixture();
  await rm(join(project.directory, "profiles"), { recursive: true });
  await project.put("custom-profiles/nested/root.yml", {
    profile: rootProfile,
    schema: { "application/json": "../../schemas/payload.json" },
    rels: {},
  });
  const relativeResult = invoke(
    ["generate-types", "restspec.yml", flag, "custom-profiles", "--out", "generated/types.ts"],
    project.directory,
  );
  success(relativeResult);
  const types = await readFile(project.output, "utf8");
  expect(types).toContain("export interface Payload");
  expect(types).toContain("export const root: ApiRoot<Payload, { staging: string; production: string; }> = {");

  const absoluteOutput = join(project.directory, "generated/absolute-types.ts");
  const absoluteResult = invoke([
    "generate-types",
    project.spec,
    flag,
    join(project.directory, "custom-profiles"),
    "--out",
    absoluteOutput,
  ]);
  success(absoluteResult);
  expect(await readFile(absoluteOutput, "utf8")).toBe(types);
});

async function httpsServer(
  routesOrFactory:
    | Readonly<Record<string, string | { status?: number; body: string }>>
    | ((baseUrl: string) => Readonly<Record<string, string | { status?: number; body: string }>>),
): Promise<{
  baseUrl: string;
  invoke: (args: readonly string[], cwd?: string) => Promise<{ status: number; stdout: string; stderr: string }>;
}> {
  const certDir = await temporaryDirectory();
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");
  const gen = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  expect(gen.status, gen.stderr).toBe(0);
  const [key, cert] = await Promise.all([
    readFile(keyPath, "utf8"),
    readFile(certPath, "utf8"),
  ]);
  let baseUrl = "";
  const server = createServer({ key, cert }, (req, res) => {
    const routes = typeof routesOrFactory === "function"
      ? routesOrFactory(baseUrl)
      : routesOrFactory;
    const pathname = new URL(req.url ?? "/", baseUrl).pathname;
    const route = routes[pathname];
    if (route === undefined) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (typeof route === "string") {
      res.writeHead(200).end(route);
      return;
    }
    res.writeHead(route.status ?? 200).end(route.body);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  onTestFinished(
    () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  );
  const { port } = server.address() as AddressInfo;
  baseUrl = `https://127.0.0.1:${port}`;
  return {
    baseUrl,
    invoke: (args, cwd = root) =>
      new Promise((resolveExec) => {
        execFile(
          process.execPath,
          [cli, ...args],
          {
            cwd,
            encoding: "utf8",
            timeout: 20_000,
            env: {
              ...process.env,
              NODE_EXTRA_CA_CERTS: certPath,
              NO_PROXY: "*",
              no_proxy: "*",
            },
          },
          (error, stdout, stderr) => {
            const status = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
            resolveExec({ status, stdout, stderr });
          },
        );
      }),
  };
}

test.each(["--config", "-c"])("generates types from a config file with %s using local paths and file: URLs", async (flag) => {
  const project = await fixture();
  await project.put("profiles/ignored.yml", {
    profile: "https://example.test/profiles/ignored",
    schema: { "application/json": "../schemas/ignored.json" },
  });
  await project.put("schemas/ignored.json", JSON.stringify({ title: "Ignored", type: "boolean" }));
  const fileUrlProfile = pathToFileURL(join(project.directory, "profiles/file-url.yml")).href;
  await project.put("profiles/file-url.yml", {
    profile: fileUrlProfile,
    schema: { "application/json": "../schemas/extra.json" },
  });
  await project.put("schemas/extra.json", JSON.stringify({ title: "Extra", type: "number" }));

  const configPath = await project.put("configs/restspec-config.yml", {
    entrypoint: "../restspec.yml",
    profiles: [
      {
        url: rootProfile,
        location: "../profiles/root.yml",
      },
      fileUrlProfile,
    ],
  });

  const result = invoke(["generate-types", flag, configPath, "--out", project.output], tmpdir());
  success(result);
  const types = await readFile(project.output, "utf8");
  expect(types).toContain("export interface Payload");
  expect(types).toContain("export interface Extra");
  expect(types).not.toContain("Ignored");
  expect(types).toContain("export const root: ApiRoot<Payload, { staging: string; production: string; }> = {");
});

test("dereferences https: URLs for entrypoint, profiles, and schemas in config", async () => {
  const project = await fixture();
  const mappedProfileUrl = "https://example.test/profiles/mapped";
  const remote = await httpsServer((origin) => ({
    "/restspec.yml": stringify({
      env: { production: { url: "https://example.test/" } },
      rootProfile: `${origin}/profiles/root`,
    }),
    "/profiles/root": stringify({
      profile: `${origin}/profiles/root`,
      schema: { "application/json": "../schemas/root.json" },
      rels: {
        related: [{ name: "mapped", profile: mappedProfileUrl }],
      },
    }),
    "/profiles/mapped.yml": stringify({
      profile: mappedProfileUrl,
      schema: { "application/json": "../schemas/mapped.json" },
    }),
    "/schemas/root.json": JSON.stringify({
      title: "RemoteRoot",
      type: "object",
      properties: { child: { $ref: "./child.json" } },
      required: ["child"],
      additionalProperties: false,
    }),
    "/schemas/child.json": JSON.stringify({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    }),
    "/schemas/mapped.json": JSON.stringify({
      title: "MappedResource",
      type: "boolean",
    }),
  }));

  const configPath = await project.put("config.yml", {
    entrypoint: `${remote.baseUrl}/restspec.yml`,
    profiles: [
      `${remote.baseUrl}/profiles/root`,
      {
        url: mappedProfileUrl,
        location: `${remote.baseUrl}/profiles/mapped.yml`,
      },
    ],
  });

  const result = await remote.invoke(["generate-types", "--config", configPath, "--out", project.output]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const types = await readFile(project.output, "utf8");
  expect(types).toContain("export interface RemoteRoot");
  expect(types).toContain("export interface MappedResource");
  expect(types).toMatch(/get "mapped"\(\): Link<\{ get: \[void, MappedResource\] \}>;/);
  expect(types).toContain("export const root: ApiRoot<RemoteRoot, { production: string; }> = {");
});

test("protects config file from being overwritten by output", async () => {
  const project = await fixture();
  const configPath = await project.put("config.ts", stringify({
    entrypoint: "./restspec.yml",
    profiles: [{ url: rootProfile, location: "./profiles/root.yml" }],
  }));
  const original = await readFile(configPath, "utf8");
  const result = invoke(["generate-types", "--config", configPath, "--out", configPath]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/output would overwrite an input file/);
  expect(await readFile(configPath, "utf8")).toBe(original);
});

test.each<[label: string, config: unknown, expected: RegExp]>([
  ["non-mapping config", "- invalid\n", /expected a YAML mapping/],
  ["missing entrypoint", { profiles: [] }, /entrypoint must be a nonempty string/],
  ["blank entrypoint", { entrypoint: "  ", profiles: [] }, /entrypoint must be a nonempty string/],
  ["http entrypoint URL", { entrypoint: "http://example.test/restspec.yml", profiles: [] }, /Only file: and https: URLs are supported/],
  ["missing profiles", { entrypoint: "./restspec.yml" }, /profiles must be an array/],
  ["non-array profiles", { entrypoint: "./restspec.yml", profiles: {} }, /profiles must be an array/],
  ["invalid profile entry type", { entrypoint: "./restspec.yml", profiles: [123] }, /profiles\[0\] must be a URL string or a mapping/],
  ["blank profile URL string", { entrypoint: "./restspec.yml", profiles: ["  "] }, /profiles\[0\] must be a nonempty string/],
  ["non-URL profile string", { entrypoint: "./restspec.yml", profiles: ["./profiles/root.yml"] }, /profiles\[0\] must be a URL/],
  ["http profile URL string", { entrypoint: "./restspec.yml", profiles: ["http://example.test/profiles/root.yml"] }, /Only file: and https: URLs are supported/],
  ["missing profile object url", { entrypoint: "./restspec.yml", profiles: [{ location: "./profiles/root.yml" }] }, /profiles\[0\]\.url must be a nonempty string/],
  ["non-URL profile object url", { entrypoint: "./restspec.yml", profiles: [{ url: "not a url", location: "./profiles/root.yml" }] }, /profiles\[0\]\.url must be a URL/],
  ["missing profile object location", { entrypoint: "./restspec.yml", profiles: [{ url: rootProfile }] }, /profiles\[0\]\.location must be a nonempty string/],
  ["http profile object location", { entrypoint: "./restspec.yml", profiles: [{ url: rootProfile, location: "http://example.test/root.yml" }] }, /Only file: and https: URLs are supported/],
  ["mismatched profile url", { entrypoint: "./restspec.yml", profiles: [{ url: "https://example.test/profiles/wrong", location: "./profiles/root.yml" }] }, /does not match configured url/],
  [
    "duplicate profile entries",
    {
      entrypoint: "./restspec.yml",
      profiles: [
        { url: rootProfile, location: "./profiles/root.yml" },
        { url: rootProfile, location: "./profiles/root.yml" },
      ],
    },
    /duplicate profile URI/,
  ],
])("reports %s in config file", async (_label, configContent, expected) => {
  const project = await fixture();
  const configPath = await project.put("config.yml", configContent);
  const result = invoke(["generate-types", "--config", configPath, "--out", project.output]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(expected);
  expect(result.stderr).not.toMatch(/\n\s+at /);
});

test("reports HTTP status errors when dereferencing https: URLs", async () => {
  const project = await fixture();
  const remote = await httpsServer({});
  const configPath = await project.put("config.yml", {
    entrypoint: `${remote.baseUrl}/missing.yml`,
    profiles: [],
  });
  const result = await remote.invoke(["generate-types", "--config", configPath, "--out", project.output]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/HTTP 404/);
});

test("shows help and package version", async () => {
  const help = invoke(["--help"]);
  success(help);
  expect(help.stdout).toMatch(/Usage: restspec generate-types <entrypoint> \[--profiles <dir>\] --out <types\.ts>/);
  expect(help.stdout).toContain("-c, --config <file>");
  expect(help.stdout).toContain("-p, --profiles <dir>");
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
  { args: ["generate-types", "spec.yml", "--profiles", "", "--out", "types.ts"] },
  { args: ["generate-types", "spec.yml", "-p", "   ", "--out", "types.ts"] },
  { args: ["generate-types", "spec.yml", "--profiles"] },
  { args: ["generate-types", "--config", "", "--out", "types.ts"] },
  { args: ["generate-types", "-c", "   ", "--out", "types.ts"] },
  { args: ["generate-types", "--config", "config.yml"] },
  { args: ["generate-types", "spec.yml", "--config", "config.yml", "--out", "types.ts"] },
  { args: ["generate-types", "--config", "config.yml", "--profiles", "profiles", "--out", "types.ts"] },
])("rejects invalid invocation $args", ({ args }) => {
  const result = invoke(args);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/restspec:/);
  expect(result.stderr).not.toMatch(/\n\s+at /);
});
