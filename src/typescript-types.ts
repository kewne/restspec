import {
  getOptionValues,
  type ClassType,
  EnumType,
  type MultiWord,
  type Name,
  ObjectType,
  type RenderContext,
  type Sourcelike,
  type Type,
  TypeScriptRenderer,
  TypeScriptTargetLanguage,
  UnionType,
} from "quicktype-core";

export const httpMethods = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

export type MethodSources = Readonly<Record<string, { request?: string; response?: string }>>;

type RootMetadata = {
  env: Readonly<Record<string, { readonly url: string; readonly description?: string }>>;
  profile: string;
  sourceName: string | undefined;
  methods: MethodSources;
};

type Relations = ReadonlyMap<string, ReadonlyMap<string, readonly {
  name: string;
  methods: MethodSources;
}[]>>;

class ExportedTypesRenderer extends TypeScriptRenderer {
  private rootName: Name | undefined;
  private readonly inlineTypes = new Set<Type>();
  private readonly recursiveTypes = new Set<Type>();

  constructor(
    language: TypeScriptTypesLanguage,
    renderContext: RenderContext,
    options: ConstructorParameters<typeof TypeScriptRenderer>[2],
    private readonly root: RootMetadata,
    private readonly relations: Relations,
    private readonly sourceKinds: ReadonlyMap<string, "request" | "response">,
  ) {
    super(language, renderContext, options);
  }

  protected override forbiddenNamesForGlobalNamespace(): string[] {
    return [...super.forbiddenNamesForGlobalNamespace(), "ApiRoot", "ENV", "Link", "Methods", "METHODS", "root"];
  }

  protected override makeNameForTopLevel(type: Type, givenName: string, namedType: Type | undefined): Name {
    const name = super.makeNameForTopLevel(type, givenName, namedType);
    if (givenName === this.root.sourceName) {
      this.rootName = name;
    }
    return name;
  }

  protected override sourceFor(type: Type): MultiWord {
    if (type instanceof EnumType) {
      return {
        needsParens: type.cases.size > 1,
        source: [...type.cases].sort().map((value, index) => [index > 0 ? " | " : "", JSON.stringify(value)]),
      };
    }
    if (type instanceof UnionType) {
      return {
        needsParens: true,
        source: [...type.sortedMembers].map((member, index) => [
          index > 0 ? " | " : "", this.sourceFor(member).source,
        ]),
      };
    }
    if (!(type instanceof ObjectType) || type.kind === "map") {
      return super.sourceFor(type);
    }
    if (this.inlineTypes.has(type)) {
      this.recursiveTypes.add(type);
      return { needsParens: false, source: this.nameForNamedType(type) };
    }
    this.inlineTypes.add(type);
    const fields: Sourcelike[] = [];
    for (const [name, property] of type.getProperties()) {
      fields.push([
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name),
        property.isOptional ? "?: " : ": ", this.sourceFor(property.type).source, ";",
      ]);
    }
    const additional = type.getAdditionalProperties();
    if (additional !== undefined) {
      fields.push(["[property: string]: ", this.sourceFor(additional).source, ";"]);
    }
    const result: MultiWord = {
      needsParens: false,
      source: fields.length === 0 ? "{}" : [
        "{", { kind: "newline", indentationChange: 1 },
        ...fields.flatMap((field, index) => index > 0
          ? [{ kind: "newline", indentationChange: 0 } as const, field] : [field]),
        { kind: "newline", indentationChange: -1 }, "}",
      ],
    };
    this.inlineTypes.delete(type);
    return result;
  }

  protected override emitClassBlock(type: ClassType, name: Name): void {
    const source = [...this.topLevels].find(([, topLevel]) => topLevel === type)?.[0];
    if (source === undefined) {
      super.emitClassBlock(type, name);
      return;
    }
    if (this.sourceKinds.get(source) === "request") {
      this.emitLine("export type ", name, " = ", this.sourceFor(type.getProperties().get("properties")!.type).source, ";");
      return;
    }
    this.emitLine("export interface ", name, " {");
    this.indent(() => {
      const properties = type.getProperties().get("properties")!;
      this.emitLine("properties: ", this.sourceFor(properties.type).source, ";");
      const relations = this.relations.get(source);
      if (relations !== undefined && relations.size > 0) {
        this.emitLine("getRel(rel: ", [...relations.keys()].map((relation) => JSON.stringify(relation)).join(" | "), "): Link[];");
      }
      this.emitLine("getRel(rel: string): Link[];");
      for (const [relation, entries] of relations ?? []) {
        const names = new Map<string, MethodSources[]>();
        for (const entry of entries) {
          const targets = names.get(entry.name) ?? [];
          names.set(entry.name, targets);
          targets.push(entry.methods);
        }
        for (const [linkName, targets] of names) {
          this.emitLine("getNamedLink(rel: ", JSON.stringify(relation), ", name: ", JSON.stringify(linkName),
            "): Link<", this.methodsSource(targets), "> | undefined;");
        }
      }
      this.emitLine("getNamedLink(rel: string, name: string): Link | undefined;");
    });
    this.emitLine("}");
  }

  private methodsSource(targets: readonly MethodSources[]): Sourcelike {
    const bodySource = (method: string, body: "request" | "response"): Sourcelike => {
      const sources = new Set(targets.map((target) => target[method]?.[body]));
      if (body === "response" && sources.has(undefined)) return "unknown";
      return [...sources].map((source, index) => {
        const type = source === undefined ? undefined : this.topLevels.get(source);
        return [
          index > 0 ? " | " : "",
          type === undefined ? (body === "request" ? "void" : "unknown") : [
            this.nameForNamedType(type),
            body === "request" && this.sourceKinds.get(source!) === "response" ? '["properties"]' : "",
          ],
        ];
      });
    };
    return ["{ ", ...httpMethods.map((method, index) => [
      index > 0 ? "; " : "", method, ": [", bodySource(method, "request"), ", ", bodySource(method, "response"), "]",
    ]), " }"];
  }

  protected override emitTypes(): void {
    this.emitLine('import type { ApiRoot, Link } from "@kewne/restspec";');
    this.ensureBlankLine();
    this.forEachTopLevel("none", (type) => {
      if (type instanceof ObjectType) {
        const properties = type.getProperties().get("properties");
        if (properties !== undefined) {
          this.sourceFor(properties.type);
        }
      }
    });
    this.forEachNamedType(
      "leading-and-interposing",
      (type, name) => {
        const sources = [...this.topLevels].filter(([, topLevel]) => topLevel === type).map(([source]) => source);
        if (sources.some((source) => this.sourceKinds.has(source))) {
          this.emitDescription(this.descriptionForType(type));
          this.emitClassBlock(type, name);
        } else if (this.recursiveTypes.has(type)) {
          this.emitLine("export type ", name, " = ", this.sourceFor(type).source, ";");
        }
      },
      () => {},
      (type, name) => {
        if (this.recursiveTypes.has(type)) {
          this.emitLine("export type ", name, " = ", this.sourceFor(type).source, ";");
        }
      },
    );
    this.ensureBlankLine();
    const envEntries = Object.entries(this.root.env);
    const envType: Sourcelike[] = envEntries.map(([name], index) => [
      index > 0 ? " " : "",
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name),
      ": string;",
    ]);
    this.emitLine(
      "export const root: ApiRoot<",
      this.rootName ?? "unknown",
      ", { ",
      envType,
      " }, ",
      this.methodsSource([this.root.methods]),
      "> = {",
    );
    this.indent(() => {
      this.emitLine("env: {");
      this.indent(() => {
        for (const [name, entry] of envEntries) {
          if (entry.description !== undefined) {
            this.emitDescription(
              entry.description.replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n").split("\n"),
            );
          }
          this.emitLine(
            /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name),
            ": ",
            JSON.stringify(entry.url),
            ",",
          );
        }
      });
      this.emitLine("},");
      this.emitLine("profile: ", JSON.stringify(this.root.profile), ",");
    });
    this.emitLine("};");
  }
}

export class TypeScriptTypesLanguage extends TypeScriptTargetLanguage {
  constructor(
    private readonly root: RootMetadata,
    private readonly relations: Relations = new Map(),
    private readonly sourceKinds: ReadonlyMap<string, "request" | "response"> = new Map(),
  ) {
    super();
  }

  protected override makeRenderer(renderContext: RenderContext): TypeScriptRenderer {
    return new ExportedTypesRenderer(
      this,
      renderContext,
      getOptionValues(this.getOptions(), {
        "just-types": "true",
        "prefer-unions": "true",
        "explicit-unions": "true",
      }),
      this.root,
      this.relations,
      this.sourceKinds,
    );
  }
}
