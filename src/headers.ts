import { tunableBounds } from "./tunables.ts";
import { parseProgram } from "./parse.ts";
import { bundledStandardLibrary, type StandardLibrary } from "./std-library.ts";
import type { BlockExpr, Expr } from "./ast.ts";

export const HEADER_NAMES = [
  "money",
  "marketplace",
  "escrow",
  "wallet",
  "financing",
  "lending",
  "insurance",
  "approvals",
  "collections",
  "travel",
  "cards",
  "savings",
  "reporting",
  "vehicles",
] as const;

/** The compiler frontend owns header metadata used by docs and catalogue consumers. */
export function headerManifest(
  library: StandardLibrary = bundledStandardLibrary,
) {
  return {
    version: 3,
    headers: HEADER_NAMES.map((name) => {
      const source = library.source(name);
      if (!source) throw new Error(`Missing standard header ${name}`);
      const parsed = parseProgram(source);
      if (parsed.diagnostics.length)
        throw new Error(`${name}: ${parsed.diagnostics[0]!.message}`);
      const spelling = (expression: Expr) =>
        source.slice(expression.span.start, expression.span.end).trim();
      const actions = (
        body: BlockExpr,
        prefix = "",
      ): Array<{ name: string; summary: string; actor: string }> => {
        const result = body.entries
          .filter((e) => e.key.startsWith("action "))
          .map((entry) => {
            const slots =
              entry.value.kind === "block" ? entry.value.entries : [];
            const summary = slots.find((e) => e.key === "summary")?.value;
            const actor = slots.find((e) => e.key === "actor")?.value;
            return {
              name: prefix + entry.key.slice(7),
              summary:
                summary?.kind === "text"
                  ? summary.value
                  : entry.key.slice(7).replaceAll("_", " "),
              actor: actor ? spelling(actor) : "caller",
            };
          });
        const records = body.entries.find((e) => e.key === "records")?.value;
        if (records?.kind === "block")
          for (const record of records.entries)
            if (record.value.kind === "block")
              result.push(...actions(record.value, `${prefix}${record.key}.`));
        return result;
      };
      return {
        name,
        objects: parsed.program.decls
          .filter((d) => d.kind === "instrument")
          .map((decl) => {
            const tunables = decl.parameters.map((parameter) => {
              const type =
                parameter.value.kind === "default"
                  ? parameter.value.type
                  : parameter.value;
              const fallback =
                parameter.value.kind === "default"
                  ? parameter.value.value
                  : undefined;
              return {
                name: parameter.key,
                type: spelling(type),
                ...(type.kind === "call" && type.name === "enum"
                  ? { values: type.args.map(spelling) }
                  : {}),
                ...tunableBounds(type),
                required: !fallback && !(type.kind === "type" && type.optional),
                ...(fallback ? { default: spelling(fallback) } : {}),
              };
            });
            // Reference selectors need program context, and text can name a target
            // action. Templates require explicit bindings instead of guessing them.
            const bindings = tunables.filter((tunable, index) => {
              const value = decl.parameters[index]!.value;
              return (
                tunable.required ||
                tunable.type === "text" ||
                (value.kind === "default" &&
                  value.value.kind === "call" &&
                  ["object", "party"].includes(value.value.name))
              );
            });
            const summary = decl.body.entries.find(
              (e) => e.key === "summary",
            )?.value;
            return {
              name: decl.name,
              qualifiedName: `${name}.${decl.name}`,
              summary:
                summary?.kind === "text"
                  ? summary.value
                  : decl.name.replaceAll("_", " "),
              authoringTemplate: {
                requiredImport: `use ${name}`,
                instancePlaceholder: "${instance}",
                source:
                  "${instance} = " +
                  `${name}.${decl.name} { ` +
                  bindings
                    .map((t) => t.name + ": ${" + t.name + "}")
                    .join(", ") +
                  " }",
                requiredBindings: bindings.map((t) => ({
                  name: t.name,
                  type: t.type,
                  placeholder: "${" + t.name + "}",
                })),
              },
              tunables,
              constraints: (() => {
                const block = decl.body.entries.find(
                  (entry) => entry.key === "constraints",
                )?.value;
                return block?.kind === "block"
                  ? block.entries.map((entry) => {
                      if (
                        entry.value.kind !== "call" ||
                        entry.value.args.length !== 1
                      )
                        throw new Error("invalid tunable constraint");
                      return {
                        tunable: entry.key,
                        relation: entry.value.name,
                        other: spelling(entry.value.args[0]!),
                      };
                    })
                  : [];
              })(),
              parties: tunables
                .filter((t) => ["party", "approval"].includes(t.type))
                .map((t) => t.name),
              actions: actions(decl.body),
            };
          }),
      };
    }),
  };
}
