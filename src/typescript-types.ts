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

type RootMetadata = {
  url: string;
  profile: string;
  sourceName: string | undefined;
};

type Relations = ReadonlyMap<string, readonly {
  relation: string;
  name: string;
  sourceName: string | undefined;
}[]>;

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
  ) {
    super(language, renderContext, options);
  }

  protected override forbiddenNamesForGlobalNamespace(): string[] {
    return [...super.forbiddenNamesForGlobalNamespace(), "ApiRoot", "Link", "Methods", "METHODS", "root"];
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
    this.emitLine("export interface ", name, " {");
    this.indent(() => {
      const properties = type.getProperties().get("properties")!;
      this.emitLine("properties: ", this.sourceFor(properties.type).source, ";");
      this.emitLine("getRel<METHODS extends Methods>(rel: string): Link<METHODS>[];");
      this.emitLine("get rels(): {");
      this.indent(() => {
        const groups = new Map<string, Map<string, Set<string | undefined>>>();
        for (const entry of this.relations.get(source) ?? []) {
          const names = groups.get(entry.relation) ?? new Map<string, Set<string | undefined>>();
          groups.set(entry.relation, names);
          const targets = names.get(entry.name) ?? new Set<string | undefined>();
          names.set(entry.name, targets);
          targets.add(entry.sourceName);
        }
        for (const [relation, names] of groups) {
          this.emitLine("get ", JSON.stringify(relation), "(): {");
          this.indent(() => {
            for (const [linkName, targets] of names) {
              const responses: Sourcelike[] = [...targets].map((target, index) => {
                const type = target === undefined ? undefined : this.topLevels.get(target);
                return [index > 0 ? " | " : "", type === undefined ? "unknown" : this.nameForNamedType(type)];
              });
              this.emitLine("get ", JSON.stringify(linkName), "(): Link<{ get: [void, ", responses, "] }>;");
            }
          });
          this.emitLine("};");
        }
      });
      this.emitLine("};");
    });
    this.emitLine("}");
  }

  protected override emitTypes(): void {
    this.emitLine('import type { ApiRoot, Link, Methods } from "restspec";');
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
        if ([...this.topLevels.values()].includes(type)) {
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
    this.emitLine("export const root: ApiRoot<", this.rootName ?? "unknown", "> = {");
    this.indent(() => {
      this.emitLine("url: ", JSON.stringify(this.root.url), ",");
      this.emitLine("profile: ", JSON.stringify(this.root.profile), ",");
    });
    this.emitLine("};");
  }
}

export class TypeScriptTypesLanguage extends TypeScriptTargetLanguage {
  constructor(private readonly root: RootMetadata, private readonly relations: Relations = new Map()) {
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
    );
  }
}
