import type { Entry, Expr, Span } from "./ast.ts";
import { headerManifest } from "./headers.ts";
import { KEYWORD_HELP } from "./keywords.ts";
import { KEYWORDS, scan, type Token } from "./lex.ts";
import { parseProgram } from "./parse.ts";
import { bundledStandardLibrary, type StandardLibrary } from "./std-library.ts";
export type { StandardLibrary } from "./std-library.ts";

export type HsxTokenClass =
  | "keyword"
  | "header"
  | "instrument"
  | "action"
  | "party"
  | "role"
  | "field"
  | "parameter"
  | "type"
  | "state"
  | "money"
  | "number"
  | "percent"
  | "duration"
  | "date"
  | "string"
  | "comment"
  | "operator"
  | "punctuation"
  | "name";
export interface HsxHighlight {
  start: number;
  end: number;
  class: HsxTokenClass;
}
export interface HsxHover {
  span: Span;
  kind: HsxTokenClass;
  title: string;
  signature?: string;
  summary: string;
  details?: { label: string; value: string }[];
  header?: string;
}
type Help = Omit<HsxHover, "span">;
type Header = ReturnType<typeof headerManifest>["headers"][number];
const keywords = new Set<string>(KEYWORDS);
const types = new Set([
  "money",
  "account",
  "ref",
  "date",
  "duration",
  "text",
  "integer",
  "percent",
  "boolean",
  "enum",
  "list",
  "policy",
]);
// Cache by source bytes, not library identity: callers can edit their own headers.
const headerCache = new Map<
  string,
  { source: string; value: Header | undefined }
>();
function header(name: string, library: StandardLibrary): Header | undefined {
  try {
    const source = library.source(name);
    if (!source) return;
    const cached = headerCache.get(name);
    if (cached?.source === source) return cached.value;
    let value: Header | undefined;
    try {
      value = headerManifest({ source: () => source }, [name]).headers[0];
    } catch {
      /* Half-written headers have no metadata yet. */
    }
    if (headerCache.size >= 64) headerCache.clear();
    headerCache.set(name, { source, value });
    return value;
  } catch {
    return;
  }
}
function instrumentHelp(
  object: Header["objects"][number],
  owner: string,
): Help {
  return {
    kind: "instrument",
    title: object.qualifiedName,
    header: owner,
    signature: object.signature,
    summary: object.summary,
    details: [
      ...object.tunables.map((t) => ({
        label: t.name,
        value: `${t.type}${t.default === undefined ? "" : ` = ${t.default}`}${"minimum" in t ? `; bounds ${t.minimum} to ${t.maximum} in UDL units` : ""}`,
      })),
      ...(object.states.length
        ? [{ label: "States", value: object.states.join(", ") }]
        : []),
      ...object.actions.map((a) => ({
        label: a.name,
        value: `${a.summary} Actor: ${a.actor}`,
      })),
    ],
  };
}
interface Binding {
  scope: Span;
  help: Help;
  declaration: number;
  keysOnly?: boolean;
  namespace?: string;
}
interface Analysis {
  highlights: HsxHighlight[];
  hovers: Map<number, HsxHover>;
}
function analyze(source: string, library: StandardLibrary): Analysis {
  const all = scan(source).tokens.filter((t) => t.kind !== "eof");
  const tokens = all.filter((t) => t.kind !== "comment");
  const helps = new Map<number, Help>();
  const classes = new Map<number, HsxTokenClass>();
  const bindings = new Map<string, Binding[]>();
  const imports = new Map<string, Header>();
  const headerHelp = new Map<string, Help>();
  const whole = { start: 0, end: source.length };
  const text = (span: Span) => source.slice(span.start, span.end);
  const mark = (token: Token | undefined, kind: HsxTokenClass, help?: Help) => {
    if (!token || token.kind !== "name") return;
    classes.set(token.span.start, kind);
    if (help) helps.set(token.span.start, help);
  };
  const bind = (
    name: string,
    scope: Span,
    declaration: number,
    help: Help,
    keysOnly = false,
    namespace?: string,
  ) => {
    const list = bindings.get(name) ?? [];
    list.push({
      scope,
      declaration,
      help,
      keysOnly,
      ...(namespace ? { namespace } : {}),
    });
    bindings.set(name, list);
  };
  const atStart = new Map(tokens.map((t, i) => [t.span.start, i]));
  const after = (span: Span) => tokens[(atStart.get(span.start) ?? -2) + 1];
  const declared = (
    name: string,
    kind: HsxTokenClass,
    scope: Span,
    span: Span,
    signature: string,
    summary: string,
    namespace?: string,
  ): Help => {
    const help: Help = {
      kind,
      title: name,
      signature,
      summary,
      details: [{ label: "Declared at", value: `UTF-16 offset ${span.start}` }],
    };
    bind(name, scope, span.start, help, false, namespace);
    return help;
  };
  // These contexts also survive missing braces and unfinished declarations.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const previous = tokens[i - 1]?.text;
    if (previous === "use") {
      const value = header(token.text, library);
      if (value) imports.set(token.text, value);
      mark(
        token,
        "header",
        value
          ? {
              kind: "header",
              title: value.name,
              header: value.name,
              summary: value.objects
                .map((o) => o.summary)
                .slice(0, 2)
                .join(" "),
              details: value.objects.map((o) => ({
                label: o.qualifiedName,
                value: o.summary,
              })),
            }
          : undefined,
      );
      const help = helps.get(token.span.start);
      if (help) headerHelp.set(token.text, help);
    }
    if (
      previous === "program" ||
      previous === "object" ||
      previous === "header"
    )
      mark(token, previous === "header" ? "header" : "name");
    if (previous === "party" && tokens[i + 1]?.text === ":") {
      mark(
        token,
        "party",
        declared(
          token.text,
          "party",
          whole,
          token.span,
          `${token.text}: ${tokens[i + 2]?.text ?? ""}`,
          `Declared party ${token.text}.`,
        ),
      );
    }
    if (previous === "role")
      mark(
        token,
        "role",
        declared(
          token.text,
          "role",
          whole,
          token.span,
          token.text,
          `Party role ${token.text}.`,
        ),
      );
    if (
      previous === "instrument" ||
      previous === "action" ||
      previous === "attach" ||
      previous === "expose" ||
      previous === "hide" ||
      previous === "as"
    )
      mark(
        token,
        previous === "instrument" || previous === "attach"
          ? "instrument"
          : "action",
      );
    if (
      ["owner", "actor", "operator"].includes(token.text) &&
      tokens[i + 1]?.text !== ":"
    )
      mark(token, "role", {
        kind: "role",
        title: token.text,
        summary:
          token.text === "owner"
            ? "The party that owns this object."
            : token.text === "actor"
              ? "The authenticated party performing this action."
              : "The party operating this product.",
      });
  }
  const attachment = (target: string, scope: Span) => {
    const [owner, name] = target.split(".");
    const object = imports
      .get(owner ?? "")
      ?.objects.find((o) => o.name === name);
    if (!object) return;
    for (const parameter of object.tunables)
      bind(
        parameter.name,
        scope,
        scope.start,
        {
          kind: "parameter",
          title: parameter.name,
          header: owner!,
          summary: `Parameter of ${object.qualifiedName}.`,
          signature: `${parameter.name}: ${parameter.type}${parameter.default === undefined ? "" : ` = ${parameter.default}`}`,
          details:
            "minimum" in parameter
              ? [
                  {
                    label: "Bounds in UDL units",
                    value: `${parameter.minimum} to ${parameter.maximum}`,
                  },
                ]
              : [],
        },
        true,
      );
    for (const action of object.actions)
      bind(action.name, scope, scope.start, {
        kind: "action",
        title: action.name,
        header: owner!,
        summary: action.summary,
        details: [{ label: "Actor", value: action.actor }],
      });
  };
  const ends = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text === "{") stack.push(i);
    if (tokens[i]!.text === "}") {
      const start = stack.pop();
      if (start !== undefined) ends.set(start, tokens[i]!.span.end);
    }
  }
  let parentheses = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === "(") parentheses++;
    if (token.text === ")") parentheses = Math.max(0, parentheses - 1);
    if (parentheses && tokens[i + 1]?.text === ":") mark(token, "parameter");
    if (
      token.text === "{" &&
      tokens[i - 2]?.text === "." &&
      tokens[i - 4]?.text === "="
    ) {
      attachment(`${tokens[i - 3]!.text}.${tokens[i - 1]!.text}`, {
        start: token.span.start,
        end: ends.get(i) ?? source.length,
      });
    }
  }
  const entryHelp = (
    entry: Entry,
    kind: HsxTokenClass,
    scope: Span,
    namespace?: string,
  ) => {
    const help = declared(
      entry.key,
      kind,
      scope,
      entry.span,
      text(entry.span),
      `${kind === "parameter" ? "Parameter" : "Field"} ${entry.key} is declared here.`,
      namespace,
    );
    mark(tokens[atStart.get(entry.span.start) ?? -1], kind, help);
  };
  const walk = (expr: Expr, scope: Span, context = "") => {
    if (expr.kind === "block") {
      for (const entry of expr.entries) {
        if (["fields", "input", "subject"].includes(context))
          entryHelp(
            entry,
            "field",
            scope,
            context === "fields" ? "self" : context,
          );
        if (entry.key.startsWith("action ")) {
          const name = entry.key.slice(7);
          const slots = entry.value.kind === "block" ? entry.value.entries : [];
          const summary = slots.find((e) => e.key === "summary")?.value;
          const actor = slots.find((e) => e.key === "actor")?.value;
          const help = declared(
            name,
            "action",
            scope,
            entry.span,
            `action ${name}`,
            summary?.kind === "text"
              ? summary.value
              : `Action ${name} on this agreement.`,
          );
          if (actor)
            help.details!.push({ label: "Actor", value: text(actor.span) });
          mark(after(entry.span), "action", help);
          walk(entry.value, entry.value.span);
        } else if (
          entry.key.startsWith("attach ") &&
          entry.value.kind === "block"
        ) {
          const [, name, , target] = entry.key.split(" ");
          const help = declared(
            name!,
            "instrument",
            scope,
            entry.span,
            `${name} = ${target}`,
            `Attachment of ${target}.`,
          );
          mark(after(entry.span), "instrument", help);
          walk(entry.value, entry.value.span);
        } else {
          if (
            context === "lifecycle" &&
            entry.key === "states" &&
            entry.value.kind === "list"
          ) {
            for (const state of entry.value.items)
              if (state.kind === "name")
                declared(
                  state.value,
                  "state",
                  scope,
                  state.span,
                  state.value,
                  `Lifecycle state ${state.value}.`,
                );
          }
          walk(
            entry.value,
            context === "records" ? entry.value.span : scope,
            entry.key,
          );
        }
      }
    } else if (expr.kind === "list")
      for (const item of expr.items) walk(item, scope, context);
    else if (expr.kind === "call")
      for (const arg of expr.args) walk(arg, scope);
    else if (expr.kind === "default") {
      walk(expr.type, scope);
      walk(expr.value, scope);
    } else if (expr.kind === "capped") {
      walk(expr.rate, scope);
      walk(expr.cap, scope);
    }
  };
  // The parser owns declarations and scopes. A parse failure leaves lexical context intact.
  try {
    const parsed = parseProgram(source);
    for (const decl of parsed.program.decls) {
      if (decl.kind === "instrument") {
        const summary = decl.body.entries.find(
          (e) => e.key === "summary",
        )?.value;
        const help = declared(
          decl.name,
          "instrument",
          whole,
          decl.span,
          source
            .slice(decl.span.start, decl.body.span.start)
            .replace(/^instrument\s+/, "")
            .trim(),
          summary?.kind === "text"
            ? summary.value
            : `Instrument ${decl.name} declared in this program.`,
        );
        mark(after(decl.span), "instrument", help);
        for (const parameter of decl.parameters)
          entryHelp(parameter, "parameter", decl.span);
        walk(decl.body, decl.span);
      } else if (decl.kind === "object") {
        mark(
          after(decl.span),
          "name",
          declared(
            decl.name,
            "name",
            whole,
            decl.span,
            `object ${decl.name}`,
            decl.title,
          ),
        );
        walk(decl.body, decl.span);
      } else if (decl.kind === "assignment") {
        declared(
          decl.name,
          "instrument",
          whole,
          decl.span,
          `${decl.name} = ${decl.target}`,
          `Instance of ${decl.target}.`,
        );
        walk(decl.body, decl.span);
      }
    }
  } catch {
    /* Arbitrary editor input must not interrupt typing. */
  }
  const hovers = new Map<number, HsxHover>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "name") continue;
    const previous = tokens[i - 1]?.text;
    const next = tokens[i + 1]?.text;
    const owner = previous === "." ? tokens[i - 2]?.text : undefined;
    const imported = owner ? imports.get(owner) : undefined;
    const object = imported?.objects.find((o) => o.name === token.text);
    if (object && owner)
      mark(token, "instrument", instrumentHelp(object, owner));
    else if (imports.has(token.text) && next === ".")
      mark(token, "header", headerHelp.get(token.text));
    else if (!helps.has(token.span.start)) {
      const candidates = bindings
        .get(token.text)
        ?.filter(
          (b) =>
            token.span.start >= b.scope.start &&
            token.span.end <= b.scope.end &&
            (!b.keysOnly || next === ":") &&
            (!b.namespace ||
              b.namespace === owner ||
              b.declaration === token.span.start) &&
            (b.help.kind !== "field" ||
              previous === "." ||
              b.declaration === token.span.start),
        );
      const binding = candidates?.sort(
        (a, b) => a.scope.end - a.scope.start - (b.scope.end - b.scope.start),
      )[0];
      const isReference =
        !keywords.has(token.text) ||
        previous === "." ||
        previous === "expose" ||
        previous === "hide" ||
        next === ":" ||
        [":", "=", "fee", "moves", "from", "to", "(", ",", "["].includes(
          previous ?? "",
        ) ||
        binding?.declaration === token.span.start;
      if (binding && isReference) mark(token, binding.help.kind, binding.help);
      else if (
        types.has(token.text) &&
        (previous === ":" ||
          previous === "<" ||
          next === "(" ||
          next === "?" ||
          next === "of")
      )
        mark(token, "type");
      else if (
        previous === "." &&
        ["self", "input", "subject"].includes(owner ?? "")
      )
        mark(token, "field");
      else if (next === ":" && !keywords.has(token.text)) mark(token, "field");
    }
    let help = helps.get(token.span.start);
    if (!help && keywords.has(token.text) && !classes.has(token.span.start)) {
      const [summary, compilesTo] = KEYWORD_HELP[
        token.text as keyof typeof KEYWORD_HELP
      ] as readonly [string, string?];
      help = {
        kind: "keyword",
        title: token.text,
        summary,
        ...(compilesTo
          ? { details: [{ label: "Compiles to", value: compilesTo }] }
          : {}),
      };
    }
    if (help) hovers.set(token.span.start, { ...help, span: token.span });
  }
  const highlights = all.map((token): HsxHighlight => {
    let kind = classes.get(token.span.start);
    if (!kind) {
      if (token.kind === "name")
        kind = keywords.has(token.text) ? "keyword" : "name";
      else if (token.kind === "punct")
        kind = /^[=<>!|]/.test(token.text) ? "operator" : "punctuation";
      else if (token.kind === "number")
        kind = token.text.endsWith("%")
          ? "percent"
          : /[a-z]$/.test(token.text)
            ? "duration"
            : "number";
      else kind = token.kind === "eof" ? "name" : token.kind;
    }
    return { ...token.span, class: kind };
  });
  for (let i = 0; i < all.length - 1; i++) {
    if (
      highlights[i]!.class === "number" &&
      all[i + 1]!.kind === "name" &&
      /^[A-Z]{3}$/.test(all[i + 1]!.text)
    ) {
      highlights[i]!.class = "money";
      highlights[i + 1]!.class = "money";
    }
  }
  return { highlights, hovers };
}
// One editor document is retained. Hovering never reparses the same keystroke.
let last:
  | { source: string; library: StandardLibrary; result: Analysis }
  | undefined;
function analysis(source: string, library: StandardLibrary): Analysis {
  // Custom libraries may change without changing identity; only the bundled library is immutable.
  if (
    library === bundledStandardLibrary &&
    last?.source === source &&
    last.library === library
  )
    return last.result;
  const result = analyze(source, library);
  if (library === bundledStandardLibrary) last = { source, library, result };
  return result;
}
/** Total, sorted, non-overlapping UTF-16 spans, including incomplete source. */
export function highlight(
  source: string,
  library: StandardLibrary = bundledStandardLibrary,
): HsxHighlight[] {
  return analysis(source, library).highlights.map((span) => ({ ...span }));
}
/** Offsets use half-open UTF-16 spans. Whitespace and out-of-range offsets return null. */
export function describe(
  source: string,
  offset: number,
  library: StandardLibrary = bundledStandardLibrary,
): HsxHover | null {
  if (!Number.isInteger(offset) || offset < 0 || offset >= source.length)
    return null;
  const result = analysis(source, library);
  const span = result.highlights.find(
    (s) => s.start <= offset && offset < s.end,
  );
  const hover = span && result.hovers.get(span.start);
  return hover
    ? {
        ...hover,
        span: { ...hover.span },
        ...(hover.details
          ? { details: hover.details.map((d) => ({ ...d })) }
          : {}),
      }
    : null;
}
