import {
  bindingDependencies,
  parameterDiagnostics,
} from "./binding-contract.ts";
import { tunableBounds } from "./tunables.ts";
import { parseHeader } from "./header-source.ts";
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
  "collections",
  "cards",
  "savings",
  "reporting",
] as const;

/** The compiler frontend owns header metadata used by docs and catalogue consumers. */
export function headerManifest(
  library: StandardLibrary = bundledStandardLibrary,
  names: readonly string[] = HEADER_NAMES,
) {
  return {
    version: 4,
    headers: names.map((name) => {
      const source = library.source(name);
      if (!source) throw new Error(`Missing standard header ${name}`);
      const parsed = parseHeader(source, name);
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
        objects: parsed.decls
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
              signature: source
                .slice(decl.span.start, decl.body.span.start)
                .replace(/^instrument\s+/, "")
                .trim(),
              states: (() => {
                const lifecycle = decl.body.entries.find(
                  (entry) => entry.key === "lifecycle",
                )?.value;
                const states =
                  lifecycle?.kind === "block"
                    ? lifecycle.entries.find((entry) => entry.key === "states")
                        ?.value
                    : undefined;
                return states?.kind === "list"
                  ? states.items.map(spelling)
                  : [];
              })(),
              summary:
                summary?.kind === "text"
                  ? summary.value
                  : decl.name.replaceAll("_", " "),
              authoringTemplate: {
                requiredImport: `use ${name}`,
                instancePlaceholder: "${instance}",
                source:
                  "attach ${instance} = " +
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
              dependencies: bindingDependencies(decl).map(
                ({ span: _span, ...dependency }) => dependency,
              ),
              parameterDiagnostics: parameterDiagnostics(decl),
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
                .filter((t) => t.type === "party")
                .map((t) => t.name),
              // Fields the attached object must carry (or rename to) before
              // the instrument's actions can read them.
              subject: (() => {
                const fields = new Map<string, string>();
                for (const entry of decl.body.entries) {
                  if (!entry.key.startsWith("action ")) continue;
                  if (entry.value.kind !== "block") continue;
                  const subject = entry.value.entries.find(
                    (slot) => slot.key === "subject",
                  )?.value;
                  if (subject?.kind !== "block") continue;
                  for (const field of subject.entries) {
                    const type = spelling(field.value);
                    if (field.key !== "adapter") fields.set(field.key, type);
                  }
                }
                return [...fields].map(([name, type]) => ({ name, type }));
              })(),
              actions: actions(decl.body),
            };
          }),
      };
    }),
  };
}
