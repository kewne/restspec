import {
  getOptionValues,
  nullableFromUnion,
  type RenderContext,
  TypeScriptRenderer,
  TypeScriptTargetLanguage,
  UnionType,
} from "quicktype-core";

class ExportedTypesRenderer extends TypeScriptRenderer {
  protected override emitTypes(): void {
    this.forEachTopLevel("interposing", (type, name) => {
      if (
        ["class", "object", "enum"].includes(type.kind) ||
        (type instanceof UnionType && nullableFromUnion(type) === null)
      ) {
        return;
      }
      this.emitDescription(this.descriptionForType(type));
      this.emitLine("export type ", name, " = ", this.sourceFor(type).source, ";");
    });
    this.forEachNamedType(
      "leading-and-interposing",
      (type, name) => {
        this.emitDescription(this.descriptionForType(type));
        this.emitClassBlock(type, name);
      },
      (type, name) => this.emitEnum(type, name),
      (type, name) => this.emitUnion(type, name),
    );
  }
}

export class TypeScriptTypesLanguage extends TypeScriptTargetLanguage {
  protected override makeRenderer(renderContext: RenderContext): TypeScriptRenderer {
    return new ExportedTypesRenderer(
      this,
      renderContext,
      getOptionValues(this.getOptions(), {
        "just-types": "true",
        "prefer-unions": "true",
        "explicit-unions": "true",
      }),
    );
  }
}
