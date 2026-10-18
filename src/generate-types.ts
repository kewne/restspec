import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { InputData, JSONSchemaInput, JSONSchemaStore, quicktype } from "quicktype-core";
import { TypeScriptTypesLanguage } from "./typescript-types.js";

type Schema = Record<string, unknown> | boolean;

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path}: ${field} must be a nonempty string`);
  }
  return value;
}

async function readMapping(path: string): Promise<Record<string, unknown>> {
  const document = parseDocument(await readFile(path, "utf8"));
  if (document.errors.length > 0) {
    throw new Error(`${path}: ${document.errors[0]?.message}`);
  }
  const value: unknown = document.toJS();
  if (!isMapping(value)) {
    throw new Error(`${path}: expected a YAML mapping`);
  }
  return value;
}

async function profileFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await profileFiles(path)));
    } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      paths.push(path);
    }
  }
  return paths;
}

class LocalSchemaStore extends JSONSchemaStore {
  readonly inputs = new Set<string>();
  readonly resourceSchemas = new Map<string, Schema>();

  override async get(address: string, debugPrint: boolean): Promise<Schema | undefined> {
    if (!URL.canParse(address)) {
      return undefined;
    }
    if (!address.startsWith("file:")) {
      throw new Error(`Only local schema references are supported: ${address}`);
    }
    return super.get(address, debugPrint);
  }

  async fetch(address: string): Promise<Schema> {
    if (!address.startsWith("file:")) {
      throw new Error(`Only local schema references are supported: ${address}`);
    }
    const resource = this.resourceSchemas.get(fileURLToPath(address));
    if (resource !== undefined) {
      return resource;
    }
    const path = await realpath(fileURLToPath(address));
    this.inputs.add(path);
    const content = await readFile(path, "utf8");
    let schema: unknown;
    try {
      schema = JSON.parse(content);
    } catch (error) {
      throw new Error(`${path}: invalid JSON`, { cause: error });
    }
    if (typeof schema !== "boolean" && !isMapping(schema)) {
      throw new Error(`${path}: expected a JSON Schema object or boolean`);
    }
    return schema;
  }
}

export async function generateTypes(
  entrypointPath: string,
  outputPath: string,
  profilesPath?: string,
): Promise<void> {
  const entrypointFile = await realpath(resolve(entrypointPath));
  const spec = await readMapping(entrypointFile);
  if (!isMapping(spec.env) || Object.keys(spec.env).length === 0) {
    throw new Error(`${entrypointFile}: env must be a nonempty environment mapping`);
  }
  const env: Record<string, { url: string; description?: string }> = {};
  for (const [name, value] of Object.entries(spec.env)) {
    const key = requiredString(name, "env key", entrypointFile);
    if (!isMapping(value)) {
      throw new Error(`${entrypointFile}: env.${key} must be a mapping`);
    }
    const description = value.description === undefined
      ? undefined
      : requiredString(value.description, `env.${key}.description`, entrypointFile);
    env[key] = {
      url: requiredString(value.url, `env.${key}.url`, entrypointFile),
      ...(description === undefined ? {} : { description }),
    };
  }
  const rootProfile = requiredString(spec.rootProfile, "rootProfile", entrypointFile);
  const profilesDir = profilesPath !== undefined
    ? resolve(profilesPath)
    : join(dirname(entrypointFile), "profiles");
  const files = await profileFiles(profilesDir);
  const profiles = new Map<string, string>();
  const profileSchemas = new Map<string, string>();
  const profileRelations = new Map<string, { relation: string; name: string; profile: string }[]>();
  const schemaFiles = new Set<string>();
  const inputs = new Set([entrypointFile]);
  let rootSchema: string | undefined;

  for (const file of files) {
    inputs.add(await realpath(file));
    const profile = await readMapping(file);
    const uri = requiredString(profile.profile, "profile", file);
    if (profiles.has(uri)) {
      throw new Error(`${file}: duplicate profile URI ${uri} (also in ${profiles.get(uri)})`);
    }
    profiles.set(uri, file);
    const relations: { relation: string; name: string; profile: string }[] = [];
    profileRelations.set(uri, relations);
    if (profile.rels !== undefined) {
      if (!isMapping(profile.rels)) {
        throw new Error(`${file}: rels must be a relation-type mapping`);
      }
      for (const [relation, descriptions] of Object.entries(profile.rels)) {
        if (!Array.isArray(descriptions)) {
          throw new Error(`${file}: rels.${relation} must be an array`);
        }
        for (const description of descriptions) {
          if (!isMapping(description)) {
            throw new Error(`${file}: rels.${relation} entries must be mappings`);
          }
          const target = requiredString(description.profile, `rels.${relation}.profile`, file);
          if (description.name !== undefined) {
            const name = requiredString(description.name, `rels.${relation}.name`, file);
            relations.push({ relation, name, profile: target });
          }
        }
      }
    }
    if (!isMapping(profile.schema)) {
      throw new Error(`${file}: schema must be a media-type mapping`);
    }
    const schema = profile.schema["application/json"];
    if (schema !== undefined) {
      const relativePath = requiredString(schema, "schema.application/json", file);
      const schemaFile = await realpath(resolve(dirname(file), relativePath));
      schemaFiles.add(schemaFile);
      profileSchemas.set(uri, schemaFile);
      if (uri === rootProfile) {
        rootSchema = schemaFile;
      }
    }
  }

  if (!profiles.has(rootProfile)) {
    throw new Error(`${entrypointFile}: rootProfile ${rootProfile} has no local profile`);
  }
  if (schemaFiles.size === 0) {
    throw new Error(`${entrypointFile}: no application/json schemas found`);
  }

  const store = new LocalSchemaStore();
  const schemaInput = new JSONSchemaInput(store);
  const names = new Map<string, string>();
  let rootSourceName: string | undefined;
  for (const file of schemaFiles) {
    const uri = pathToFileURL(file).href;
    const schema = await store.fetch(uri);
    const title = isMapping(schema) ? schema.title : undefined;
    const name = title !== undefined
      ? requiredString(title, "schema title", file)
      : basename(file).replace(/\.json$/i, "");
    if (names.has(name)) {
      throw new Error(`${file}: duplicate schema type name ${name} (also in ${names.get(name)})`);
    }
    names.set(name, file);
    if (file === rootSchema) {
      rootSourceName = name;
    }
    const resourcePath = `${file}.restspec-resource`;
    store.resourceSchemas.set(resourcePath, {
      title: name,
      type: "object",
      properties: { properties: { $ref: uri } },
      required: ["properties"],
      additionalProperties: false,
    });
    await schemaInput.addSource({ name, uris: [pathToFileURL(resourcePath).href] });
  }

  const inputData = new InputData();
  inputData.addInput(schemaInput);
  const sourceNames = new Map([...names].map(([name, file]) => [file, name]));
  const relations = new Map<string, { relation: string; name: string; sourceName: string | undefined }[]>();
  for (const [profile, descriptions] of profileRelations) {
    const schema = profileSchemas.get(profile);
    const sourceName = schema === undefined ? undefined : sourceNames.get(schema);
    if (sourceName === undefined) {
      continue;
    }
    const entries = relations.get(sourceName) ?? [];
    relations.set(sourceName, entries);
    for (const description of descriptions) {
      const target = profileSchemas.get(description.profile);
      entries.push({
        relation: description.relation,
        name: description.name,
        sourceName: target === undefined ? undefined : sourceNames.get(target),
      });
    }
  }
  const { lines } = await quicktype({
    inputData,
    lang: new TypeScriptTypesLanguage({ env, profile: rootProfile, sourceName: rootSourceName }, relations),
    inferDateTimes: false,
  });

  const output = resolve(outputPath);
  if (extname(output) !== ".ts") {
    throw new Error(`${output}: output must have a .ts extension`);
  }
  const target = await realpath(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return output;
  });
  if (inputs.has(target) || store.inputs.has(target)) {
    throw new Error(`${output}: output would overwrite an input file`);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${lines.join("\n")}\n`, "utf8");
}
