import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { InputData, JSONSchemaInput, JSONSchemaStore, quicktype } from "quicktype-core";
import { httpMethods, type MethodSources, TypeScriptTypesLanguage } from "./typescript-types.js";

type Schema = Record<string, unknown> | boolean;

type Location =
  | { kind: "file"; path: string; label: string; url: string }
  | { kind: "https"; label: string; url: string };

export type GenerateTypesOptions =
  | { entrypointPath: string; profilesPath?: string; outputPath: string }
  | { configPath: string; outputPath: string };

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUrl(value: string): boolean {
  return !/^[a-zA-Z]:[\\/]/.test(value) && URL.canParse(value);
}

function requiredString(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path}: ${field} must be a nonempty string`);
  }
  return value;
}

async function resolveUrlLocation(rawUrl: string, inputs: Set<string>): Promise<Location> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "https:") {
    return { kind: "https", label: parsed.href, url: parsed.href };
  }
  if (parsed.protocol === "file:") {
    const path = await realpath(fileURLToPath(parsed));
    inputs.add(path);
    return { kind: "file", path, label: path, url: pathToFileURL(path).href };
  }
  throw new Error(`Only file: and https: URLs are supported: ${rawUrl}`);
}

async function resolveLocation(
  rawLocation: string,
  baseDir: string,
  inputs: Set<string>,
): Promise<Location> {
  if (isUrl(rawLocation)) {
    return resolveUrlLocation(rawLocation, inputs);
  }
  const resolved = resolve(baseDir, rawLocation);
  const path = await realpath(resolved);
  inputs.add(path);
  return { kind: "file", path, label: path, url: pathToFileURL(path).href };
}

async function resolveSchemaLocation(
  rawSchema: string,
  profileLocation: Location,
  inputs: Set<string>,
): Promise<Location> {
  if (profileLocation.kind === "file") {
    return resolveLocation(rawSchema, dirname(profileLocation.path), inputs);
  }
  const parsed = new URL(rawSchema, profileLocation.url);
  return resolveUrlLocation(parsed.href, inputs);
}

async function readText(location: Location): Promise<string> {
  if (location.kind === "file") {
    return readFile(location.path, "utf8");
  }
  let response: Response;
  try {
    response = await fetch(location.url);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${location.url}: ${detail}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`${location.url}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function readMapping(location: Location): Promise<Record<string, unknown>> {
  const document = parseDocument(await readText(location));
  if (document.errors.length > 0) {
    throw new Error(`${location.label}: ${document.errors[0]?.message}`);
  }
  const value: unknown = document.toJS();
  if (!isMapping(value)) {
    throw new Error(`${location.label}: expected a YAML mapping`);
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
    const parsed = new URL(address);
    if (parsed.protocol !== "file:" && parsed.protocol !== "https:") {
      throw new Error(`Only file: and https: schema references are supported: ${address}`);
    }
    return super.get(address, debugPrint);
  }

  async fetch(address: string): Promise<Schema> {
    const resource = this.resourceSchemas.get(address);
    if (resource !== undefined) {
      return resource;
    }
    const parsed = new URL(address);
    let label: string;
    let content: string;
    if (parsed.protocol === "file:") {
      const path = await realpath(fileURLToPath(parsed));
      this.inputs.add(path);
      label = path;
      content = await readFile(path, "utf8");
    } else if (parsed.protocol === "https:") {
      label = parsed.href;
      content = await readText({ kind: "https", label, url: parsed.href });
    } else {
      throw new Error(`Only file: and https: schema references are supported: ${address}`);
    }
    let schema: unknown;
    try {
      schema = JSON.parse(content);
    } catch (error) {
      throw new Error(`${label}: invalid JSON`, { cause: error });
    }
    if (typeof schema !== "boolean" && !isMapping(schema)) {
      throw new Error(`${label}: expected a JSON Schema object or boolean`);
    }
    return schema;
  }
}

export async function generateTypes(
  entrypointOrOptions: string | GenerateTypesOptions,
  outputPath?: string,
  profilesPath?: string,
): Promise<void> {
  const options: GenerateTypesOptions = typeof entrypointOrOptions === "string"
    ? {
        entrypointPath: entrypointOrOptions,
        outputPath: outputPath!,
        ...(profilesPath === undefined ? {} : { profilesPath }),
      }
    : entrypointOrOptions;

  const inputs = new Set<string>();
  let entrypointLocation: Location;
  const profileEntries: { location: Location; expectedUrl?: string }[] = [];

  if ("configPath" in options) {
    const configFile = await realpath(resolve(options.configPath));
    inputs.add(configFile);
    const config = await readMapping({
      kind: "file",
      path: configFile,
      label: configFile,
      url: pathToFileURL(configFile).href,
    });
    const configDir = dirname(configFile);
    const rawEntrypoint = requiredString(config.entrypoint, "entrypoint", configFile);
    entrypointLocation = await resolveLocation(rawEntrypoint, configDir, inputs);
    if (!Array.isArray(config.profiles)) {
      throw new Error(`${configFile}: profiles must be an array`);
    }
    for (const [index, entry] of config.profiles.entries()) {
      if (typeof entry === "string") {
        const url = requiredString(entry, `profiles[${index}]`, configFile);
        if (!isUrl(url)) {
          throw new Error(`${configFile}: profiles[${index}] must be a URL`);
        }
        const location = await resolveUrlLocation(url, inputs);
        profileEntries.push({ location, expectedUrl: url });
      } else if (isMapping(entry)) {
        const url = requiredString(entry.url, `profiles[${index}].url`, configFile);
        if (!isUrl(url)) {
          throw new Error(`${configFile}: profiles[${index}].url must be a URL`);
        }
        const rawLocation = requiredString(entry.location, `profiles[${index}].location`, configFile);
        const location = await resolveLocation(rawLocation, configDir, inputs);
        profileEntries.push({ location, expectedUrl: url });
      } else {
        throw new Error(`${configFile}: profiles[${index}] must be a URL string or a mapping`);
      }
    }
  } else {
    const entrypointFile = await realpath(resolve(options.entrypointPath));
    inputs.add(entrypointFile);
    entrypointLocation = {
      kind: "file",
      path: entrypointFile,
      label: entrypointFile,
      url: pathToFileURL(entrypointFile).href,
    };
    const profilesDir = options.profilesPath !== undefined
      ? resolve(options.profilesPath)
      : join(dirname(entrypointFile), "profiles");
    const files = await profileFiles(profilesDir);
    for (const file of files) {
      const resolvedFile = await realpath(file);
      inputs.add(resolvedFile);
      profileEntries.push({
        location: {
          kind: "file",
          path: resolvedFile,
          label: file,
          url: pathToFileURL(resolvedFile).href,
        },
      });
    }
  }

  const entrypointLabel = entrypointLocation.label;
  const spec = await readMapping(entrypointLocation);
  if (!isMapping(spec.env) || Object.keys(spec.env).length === 0) {
    throw new Error(`${entrypointLabel}: env must be a nonempty environment mapping`);
  }
  const env: Record<string, { url: string; description?: string }> = {};
  for (const [name, value] of Object.entries(spec.env)) {
    const key = requiredString(name, "env key", entrypointLabel);
    if (!isMapping(value)) {
      throw new Error(`${entrypointLabel}: env.${key} must be a mapping`);
    }
    const description = value.description === undefined
      ? undefined
      : requiredString(value.description, `env.${key}.description`, entrypointLabel);
    env[key] = {
      url: requiredString(value.url, `env.${key}.url`, entrypointLabel),
      ...(description === undefined ? {} : { description }),
    };
  }
  const rootProfile = requiredString(spec.rootProfile, "rootProfile", entrypointLabel);
  const profiles = new Map<string, string>();
  const profileMethods = new Map<string, Record<string, { request?: string; response?: string }>>();
  const profileRelations = new Map<string, Map<string, { name: string; profile: string }[]>>();
  const schemaLocations = new Map<string, Location>();
  const responseSchemas = new Set<string>();

  for (const { location, expectedUrl } of profileEntries) {
    const label = location.label;
    const profile = await readMapping(location);
    const uri = requiredString(profile.profile, "profile", label);
    if (expectedUrl !== undefined && uri !== expectedUrl) {
      throw new Error(`${label}: profile ${uri} does not match configured url ${expectedUrl}`);
    }
    if (profiles.has(uri)) {
      throw new Error(`${label}: duplicate profile URI ${uri} (also in ${profiles.get(uri)})`);
    }
    profiles.set(uri, label);
    const relations = new Map<string, { name: string; profile: string }[]>();
    profileRelations.set(uri, relations);
    if (profile.rels !== undefined) {
      if (!isMapping(profile.rels)) {
        throw new Error(`${label}: rels must be a relation-type mapping`);
      }
      for (const [relation, descriptions] of Object.entries(profile.rels)) {
        if (!Array.isArray(descriptions)) {
          throw new Error(`${label}: rels.${relation} must be an array`);
        }
        const targets: { name: string; profile: string }[] = [];
        relations.set(relation, targets);
        for (const description of descriptions) {
          if (!isMapping(description)) {
            throw new Error(`${label}: rels.${relation} entries must be mappings`);
          }
          const target = requiredString(description.profile, `rels.${relation}.profile`, label);
          if (description.name !== undefined) {
            const name = requiredString(description.name, `rels.${relation}.name`, label);
            targets.push({ name, profile: target });
          }
        }
      }
    }
    if (profile.schema !== undefined && !isMapping(profile.schema)) {
      throw new Error(`${label}: schema must be a media-type mapping`);
    }
    const methods: Record<string, { request?: string; response?: string }> = {};
    profileMethods.set(uri, methods);
    const schema = profile.schema?.["application/json"];
    if (schema !== undefined) {
      if (!isMapping(schema)) {
        throw new Error(`${label}: schema.application/json must be an HTTP-method mapping`);
      }
      for (const [method, bodies] of Object.entries(schema)) {
        if (!httpMethods.some((supported) => supported === method)) {
          throw new Error(`${label}: schema.application/json.${method}: unsupported HTTP method`);
        }
        if (!isMapping(bodies)) {
          throw new Error(`${label}: schema.application/json.${method} must be a body-schema mapping`);
        }
        const slots: { request?: string; response?: string } = {};
        methods[method] = slots;
        for (const [body, reference] of Object.entries(bodies)) {
          if (body !== "request" && body !== "response") {
            throw new Error(`${label}: schema.application/json.${method}.${body}: unknown body schema`);
          }
          const relativePath = requiredString(reference, `schema.application/json.${method}.${body}`, label);
          const schemaLocation = await resolveSchemaLocation(relativePath, location, inputs);
          schemaLocations.set(schemaLocation.url, schemaLocation);
          slots[body] = schemaLocation.url;
          if (body === "response") {
            responseSchemas.add(schemaLocation.url);
          }
        }
      }
    }
  }

  if (!profiles.has(rootProfile)) {
    throw new Error(`${entrypointLabel}: rootProfile ${rootProfile} has no local profile`);
  }

  const store = new LocalSchemaStore();
  const schemaInput = new JSONSchemaInput(store);
  const names = new Map<string, string>();
  const schemaNames = new Map<string, string>();
  const sourceNames = new Map<string, string>();
  const sourceKinds = new Map<string, "request" | "response">();
  for (const schemaLocation of schemaLocations.values()) {
    const uri = schemaLocation.url;
    const label = schemaLocation.label;
    const schema = await store.fetch(uri);
    const title = isMapping(schema) ? schema.title : undefined;
    const fallbackName = schemaLocation.kind === "file"
      ? basename(schemaLocation.path).replace(/\.json$/i, "")
      : decodeURIComponent(basename(new URL(schemaLocation.url).pathname)).replace(/\.json$/i, "");
    const name = title !== undefined
      ? requiredString(title, "schema title", label)
      : requiredString(fallbackName, "schema name", label);
    if (names.has(name)) {
      throw new Error(`${label}: duplicate schema type name ${name} (also in ${names.get(name)})`);
    }
    names.set(name, label);
    schemaNames.set(uri, name);
  }
  for (const [uri, name] of schemaNames) {
    const kind = responseSchemas.has(uri) ? "response" : "request";
    let sourceName = kind === "request" ? `${name}Request` : name;
    while (kind === "request" && (names.has(sourceName) || sourceKinds.has(sourceName))) {
      sourceName += "Request";
    }
    sourceNames.set(uri, sourceName);
    sourceKinds.set(sourceName, kind);
    const resourceUri = `${uri}.restspec-resource`;
    store.resourceSchemas.set(resourceUri, {
      title: sourceName,
      type: "object",
      properties: { properties: { $ref: uri } },
      required: ["properties"],
      additionalProperties: false,
    });
    await schemaInput.addSource({ name: sourceName, uris: [resourceUri] });
  }

  if (schemaLocations.size === 0) {
    await schemaInput.addSource({ name: "RestspecEmpty", schema: "true" });
  }
  const inputData = new InputData();
  inputData.addInput(schemaInput);
  const methodsFor = (profile: string): MethodSources => Object.fromEntries(
    Object.entries(profileMethods.get(profile) ?? {}).map(([method, bodies]) => [method, {
      ...(bodies.request === undefined ? {} : { request: sourceNames.get(bodies.request)! }),
      ...(bodies.response === undefined ? {} : { response: sourceNames.get(bodies.response)! }),
    }]),
  );
  const relations = new Map<string, Map<string, { name: string; methods: MethodSources }[]>>();
  for (const [profile, groups] of profileRelations) {
    const responses = new Set(Object.values(methodsFor(profile)).map((bodies) => bodies.response));
    for (const sourceName of responses) {
      if (sourceName === undefined) continue;
      const entries = relations.get(sourceName) ?? new Map<string, { name: string; methods: MethodSources }[]>();
      relations.set(sourceName, entries);
      for (const [relation, descriptions] of groups) {
        const targets = entries.get(relation) ?? [];
        entries.set(relation, targets);
        for (const description of descriptions) {
          targets.push({ name: description.name, methods: methodsFor(description.profile) });
        }
      }
    }
  }
  const rootMethods = methodsFor(rootProfile);
  const { lines } = await quicktype({
    inputData,
    lang: new TypeScriptTypesLanguage(
      { env, profile: rootProfile, sourceName: rootMethods.get?.response, methods: rootMethods },
      relations,
      sourceKinds,
    ),
    inferDateTimes: false,
  });

  const output = resolve(options.outputPath);
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
