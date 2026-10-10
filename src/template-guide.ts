import type { BlockExpr, Entry, Expr, InstrumentDecl } from "./ast.ts";
import { catalogProgramSource } from "./catalog-program.ts";
import { compile, type CompileOptions } from "./compile.ts";
import { parseHeader } from "./header-source.ts";
import { headerManifest, HEADER_NAMES } from "./headers.ts";
import { parseProgram } from "./parse.ts";
import { bundledStandardLibrary, type StandardLibrary } from "./std-library.ts";

export interface TemplateIndexEntry {
  qualifiedName: string;
  summary: string;
  parties: string[];
}

export interface TemplateGuideAction {
  name: string;
  runBy: string;
  from?: string;
  to?: string;
  due?: string;
  deadline?: string;
  requires?: string[];
  moves?: string[];
  invokes?: string[];
  when?: string;
}

export interface TemplateGuide {
  qualifiedName: string;
  summary: string;
  signature: string;
  use: string;
  states: string[];
  tunables: Array<{
    name: string;
    type: string;
    required: boolean;
    default?: string;
    meaning: string;
  }>;
  createInput: Array<{ name: string; type: string }>;
  subject: Array<{ name: string; type: string }>;
  actions: TemplateGuideAction[];
  example: string;
  notes: string[];
}

// How to read runBy, the same for every template.
const RUN_BY_NOTE =
  "runBy names who runs each action: a party is whoever the attach binds to it (owner, actor, operator or a declared business), clock is the platform when the action falls due, parent runs only inside its parent record's action, and caller is anyone the exposed action admits.";

const SUBJECT_NOTE =
  "subject names fields the attached object must carry, or rename to with rename { field: yourField }, before the actions that read them can run.";

/** One line per template, small enough to read whole. */
export function templateIndex(
  library: StandardLibrary = bundledStandardLibrary,
): TemplateIndexEntry[] {
  return headerManifest(library).headers.flatMap((header) =>
    header.objects.map((object) => ({
      qualifiedName: object.qualifiedName,
      summary: object.summary,
      parties: object.parties,
    })),
  );
}

/**
 * Everything an author needs for one template, spelled from its std
 * declaration and proved by compiling its example. Undefined when the
 * catalog has no such template.
 */
export function templateGuide(
  qualifiedName: string,
  options: GuideOptions = {},
): TemplateGuide | undefined {
  const library = options.library ?? bundledStandardLibrary;
  const [header, name, extra] = qualifiedName.split(".");
  if (!header || !name || extra !== undefined) return undefined;
  if (!(HEADER_NAMES as readonly string[]).includes(header)) return undefined;
  const source = library.source(header);
  if (!source) return undefined;
  const manifest = headerManifest(library, [header]).headers[0]!.objects.find(
    (object) => object.name === name,
  );
  const decl = parseHeader(source, header).decls.find(
    (d): d is InstrumentDecl => d.kind === "instrument" && d.name === name,
  );
  if (!manifest || !decl) return undefined;
  const spell = (expression: Expr) =>
    source
      .slice(expression.span.start, expression.span.end)
      .trim()
      .replace(/\s+/g, " ");
  const actions = guideActions(decl.body, spell);
  // Compile once bare, then expose each root action a party or caller runs
  // that these bindings keep, and compile again to prove the example.
  const example = exampleProgram(qualifiedName, library);
  const bare = compiledAttachment(
    example.render([]),
    example.attachment,
    options,
  );
  const exposes = actions
    .filter(
      (action) =>
        !action.name.includes(".") &&
        !["clock", "parent"].includes(action.runBy) &&
        bare.actions[action.name],
    )
    .map((action) => `expose ${action.name}`);
  const program = example.render(exposes);
  const create = compiledAttachment(program, example.attachment, options)
    .actions.create;
  return {
    qualifiedName,
    summary: manifest.summary,
    signature: manifest.signature,
    use: `use ${header}`,
    states: manifest.states,
    tunables: manifest.tunables.map((tunable) => ({
      name: tunable.name,
      type: tunable.type,
      required: tunable.required,
      ...(tunable.default ? { default: tunable.default } : {}),
      meaning:
        tunable.type === "party" || tunable.type === "party?"
          ? partyMeaning(tunable.name, actions)
          : valueMeaning(tunable.name, tunable.default, decl, spell),
    })),
    createInput: (create?.input ?? []).map((field) => ({
      name: field.name,
      type: inputType(field as unknown as Record<string, unknown>),
    })),
    subject: manifest.subject,
    actions,
    example: program,
    notes: [RUN_BY_NOTE, ...(manifest.subject.length ? [SUBJECT_NOTE] : [])],
  };
}

function slot(block: BlockExpr, key: string) {
  return block.entries.find((entry) => entry.key === key)?.value;
}

/**
 * The parser desugars `requires` and `moves` into blocks without source
 * spans, so each clause is spelled from the slot's own source text.
 */
function clauses(
  action: BlockExpr,
  key: "requires" | "moves",
  spell: (expression: Expr) => string,
) {
  return action.entries
    .filter((entry) => entry.key === key)
    .flatMap((entry) =>
      spell(entry.value)
        .split(new RegExp(`(?:^|[;,]?\\s+)${key}\\s+`))
        .map((clause) => clause.trim().replace(/[;,]$/, ""))
        .filter(Boolean),
    );
}

function items(expression: Expr | undefined): Expr[] {
  if (!expression) return [];
  return expression.kind === "list" ? expression.items : [expression];
}

/** Root actions first, then each record's, prefixed with the record name. */
function guideActions(
  body: BlockExpr,
  spell: (expression: Expr) => string,
  prefix = "",
  parentActions: TemplateGuideAction[] = [],
): TemplateGuideAction[] {
  const result: TemplateGuideAction[] = [];
  for (const entry of body.entries) {
    if (!entry.key.startsWith("action ") || entry.value.kind !== "block")
      continue;
    const action = entry.value;
    const actor = slot(action, "actor");
    const party = actor?.kind === "block" ? slot(actor, "party") : undefined;
    const parent = actor?.kind === "block" ? slot(actor, "parent") : undefined;
    const runBy = !actor
      ? "caller"
      : party
        ? spell(party)
        : parent
          ? "parent"
          : spell(actor);
    const at = (key: string) => {
      const value = slot(action, key);
      if (value?.kind !== "block") return value ? spell(value) : undefined;
      const instant = slot(value, "at");
      const offset = slot(value, "offset");
      if (!instant) return spell(value);
      return offset ? `${spell(instant)} + ${spell(offset)}` : spell(instant);
    };
    const due = at("due");
    const deadline = at("deadline");
    const requires = clauses(action, "requires", spell);
    const moves = clauses(action, "moves", spell);
    const invokes = items(slot(action, "invoke")).flatMap((item) =>
      item.kind === "block" ? [invocation(item, spell, prefix)] : [],
    );
    const from = slot(action, "from");
    const to = slot(action, "to");
    const guide: TemplateGuideAction = {
      name: prefix + entry.key.slice(7),
      runBy,
      ...(from ? { from: spell(from) } : {}),
      ...(to ? { to: spell(to) } : {}),
      ...(due ? { due } : {}),
      ...(deadline ? { deadline } : {}),
      ...(requires.length ? { requires } : {}),
      ...(moves.length ? { moves } : {}),
      ...(invokes.length ? { invokes } : {}),
    };
    const when = timing(guide, parentActions);
    result.push(when ? { ...guide, when } : guide);
  }
  const records = slot(body, "records");
  if (records?.kind === "block")
    for (const record of records.entries)
      if (record.value.kind === "block")
        result.push(
          ...guideActions(
            record.value,
            spell,
            `${prefix}${record.key}.`,
            prefix ? parentActions : result,
          ),
        );
  return result;
}

function invocation(
  block: BlockExpr,
  spell: (expression: Expr) => string,
  prefix: string,
) {
  const instrument = slot(block, "instrument");
  const action = slot(block, "action");
  const target = `${instrument ? `${prefix}${spell(instrument)}.` : ""}${action ? spell(action) : "?"}`;
  const range = slot(block, "range");
  const count = range?.kind === "block" ? slot(range, "count") : undefined;
  const literal =
    count?.kind === "block" ? (slot(count, "literal") ?? count) : count;
  const selection = slot(block, "selection");
  const selected =
    selection?.kind === "block" ? slot(selection, "instrument") : undefined;
  return literal
    ? `${target}, ${spell(literal)} times`
    : selected
      ? `${target} on each matching ${spell(selected)}`
      : target;
}

/**
 * The runtime's timing rules, applied to one action: a clock action that
 * needs a record in another state waits, and the action that moves the
 * record there collects it in the same request (docs/public/runtime.md).
 */
function timing(
  action: TemplateGuideAction,
  parentActions: TemplateGuideAction[],
): string | undefined {
  if (action.runBy === "clock" && action.due) {
    const waits = (action.requires ?? []).flatMap((requirement) => {
      const match = requirement.match(/^self\.\w+ in \[([^\]]+)\]$/);
      return match ? [{ requirement, states: match[1]!.split(/,\s*/) }] : [];
    });
    const openers = parentActions
      .filter((parent) =>
        waits.some((wait) => wait.states.includes(parent.to ?? "")),
      )
      .map((parent) => parent.name);
    return [
      `The clock runs it at ${action.due}.`,
      ...waits.map(
        (wait) => `While ${wait.requirement} does not hold, it waits.`,
      ),
      ...(openers.length
        ? [
            `${openers.join(" or ")} collects every one already due in the same request.`,
          ]
        : []),
    ].join(" ");
  }
  const parts = [
    ...(action.due
      ? [`Runnable from ${action.due}; ${action.runBy} still runs it.`]
      : []),
    ...(action.deadline ? [`Refused after ${action.deadline}.`] : []),
  ];
  return parts.length ? parts.join(" ") : undefined;
}

function partyMeaning(name: string, actions: TemplateGuideAction[]) {
  const runs = actions.filter((action) => action.runBy === name);
  const pays = actions.filter((action) =>
    action.moves?.some((move) => new RegExp(`\\bfrom ${name}\\b`).test(move)),
  );
  const receives = actions.filter((action) =>
    action.moves?.some((move) => new RegExp(`\\bto ${name}\\b`).test(move)),
  );
  const names = (list: TemplateGuideAction[]) =>
    list.map((action) => action.name).join(", ");
  const parts = [
    ...(runs.length ? [`Runs ${names(runs)}.`] : []),
    ...(pays.length ? [`Pays in ${names(pays)}.`] : []),
    ...(receives.length ? [`Receives in ${names(receives)}.`] : []),
  ];
  return parts.length
    ? parts.join(" ")
    : "Named by the template; runs no action and moves no money itself.";
}

/**
 * A value tunable's meaning is where it lands: the fields it sets and every
 * field or action that reads those fields, spelled as the std writes them.
 */
function valueMeaning(
  name: string,
  fallback: string | undefined,
  decl: InstrumentDecl,
  spell: (expression: Expr) => string,
) {
  const bare = new RegExp(`(?<![\\w.])${name}(?!\\w)`);
  const fields = slot(decl.body, "fields");
  const set =
    fields?.kind === "block"
      ? fields.entries.filter((entry) => bare.test(fieldValue(entry, spell)))
      : [];
  const read = new Set(set.map((entry) => entry.key));
  const uses: string[] = [];
  const visit = (body: BlockExpr, prefix: string, parentRefs: string[]) => {
    const own = slot(body, "fields");
    const reads = (text: string) =>
      bare.test(text) ||
      [...read].some((field) =>
        prefix
          ? parentRefs.some((ref) =>
              new RegExp(`\\bself\\.${ref}\\.${field}\\b`).test(text),
            )
          : new RegExp(`\\bself\\.${field}\\b`).test(text),
      );
    if (own?.kind === "block" && prefix)
      for (const entry of own.entries) {
        const value = fieldValue(entry, spell);
        if (reads(value)) uses.push(`${prefix}${entry.key}: ${value}`);
      }
    for (const entry of body.entries) {
      if (!entry.key.startsWith("action ") || entry.value.kind !== "block")
        continue;
      for (const part of entry.value.entries) {
        if (["actor", "from", "to", "summary"].includes(part.key)) continue;
        const text = spell(part.value);
        // A long slot, such as an invoke list, is named rather than spelled.
        if (reads(text))
          uses.push(
            `${prefix}${entry.key.slice(7)} ${part.key}${text.length > 100 ? "" : `: ${text}`}`,
          );
      }
    }
    const records = slot(body, "records");
    if (records?.kind === "block")
      for (const record of records.entries) {
        if (record.value.kind !== "block") continue;
        const recordFields = slot(record.value, "fields");
        const refs =
          recordFields?.kind === "block"
            ? recordFields.entries
                .filter((entry) =>
                  /^ref<parent>/.test(fieldValue(entry, spell)),
                )
                .map((entry) => entry.key)
            : [];
        visit(record.value, `${prefix}${record.key}.`, refs);
      }
  };
  visit(decl.body, "", []);
  const parts = [
    ...(fallback === "runtime"
      ? [
          `Leave it out of the attach and create takes ${name} for each record, or bind one fixed value.`,
        ]
      : []),
    ...(set.length
      ? [
          `Sets ${set.map((entry) => `${entry.key}: ${fieldValue(entry, spell)}`).join(", ")}.`,
        ]
      : []),
    ...(uses.length ? [`Read by ${uses.slice(0, 6).join("; ")}.`] : []),
  ];
  return parts.length ? parts.join(" ") : "Configures the template.";
}

function fieldValue(entry: Entry, spell: (expression: Expr) => string) {
  return entry.value.kind === "default"
    ? `${spell(entry.value.type)} = ${spell(entry.value.value)}`
    : spell(entry.value);
}

interface Example {
  attachment: string;
  render(exposes: string[]): string;
}

/**
 * The template's attach from the catalog program, with every attach it names
 * and the parties and headers those need.
 */
function exampleProgram(
  qualifiedName: string,
  library: StandardLibrary,
): Example {
  const program = parseProgram(catalogProgramSource).program;
  const object = program.decls.find((decl) => decl.kind === "object");
  if (object?.kind !== "object")
    throw new Error("catalog program has no object");
  const attaches = object.body.entries.flatMap((entry) => {
    const match = entry.key.match(/^attach (\w+) = (\w+)\.(\w+)$/);
    return match
      ? [
          {
            entry,
            name: match[1]!,
            header: match[2]!,
            template: `${match[2]}.${match[3]}`,
          },
        ]
      : [];
  });
  const target = attaches.find((attach) => attach.template === qualifiedName);
  if (!target)
    throw new Error(`catalog program does not attach ${qualifiedName}`);
  const referenced = (expression: Expr): string[] => {
    if (expression.kind === "name") return [expression.value.split(".")[0]!];
    if (expression.kind === "list") return expression.items.flatMap(referenced);
    if (expression.kind === "block")
      return expression.entries.flatMap((entry) => referenced(entry.value));
    return [];
  };
  // A parameter that defaults to object(header.template) binds the sibling
  // attach of that template, so the example carries that attach too.
  const templates = new Map(
    headerManifest(library).headers.flatMap((header) =>
      header.objects.map((object) => [object.qualifiedName, object] as const),
    ),
  );
  const siblings = (template: string) =>
    (templates.get(template)?.tunables ?? []).flatMap((tunable) => {
      const match = tunable.default?.match(/^object\((\w+\.\w+)\)$/);
      const sibling = match
        ? attaches.find((attach) => attach.template === match[1])
        : undefined;
      return sibling ? [sibling.name] : [];
    });
  const names = new Set<string>();
  const include = (name: string) => {
    if (names.has(name)) return;
    const attach = attaches.find((candidate) => candidate.name === name);
    if (!attach) return;
    names.add(name);
    [...referenced(attach.entry.value), ...siblings(attach.template)].forEach(
      include,
    );
  };
  include(target.name);
  const included = attaches.filter((attach) => names.has(attach.name));
  const used = new Set(
    included.flatMap((attach) => referenced(attach.entry.value)),
  );
  const text = (span: { start: number; end: number }) =>
    catalogProgramSource.slice(span.start, span.end).trim();
  return {
    attachment: target.name,
    render: (exposes) =>
      [
        `program example "${qualifiedName} example"`,
        ...new Set(included.map((attach) => `use ${attach.header}`)),
        ...program.decls.flatMap((decl) =>
          decl.kind === "party" && used.has(decl.name) ? [text(decl.span)] : [],
        ),
        `object item "Item" {`,
        ...included.map((attach) => {
          const line = text(attach.entry.span);
          return wrapAttach(
            attach === target && exposes.length
              ? line.replace(/\s*\}$/, `, ${exposes.join(", ")} }`)
              : line,
          );
        }),
        "}",
      ].join("\n"),
  };
}

/** An attach line within 76 columns, else one binding per line. */
function wrapAttach(line: string): string {
  if (line.length <= 74) return `  ${line}`;
  const open = line.indexOf("{");
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = open + 1;
  for (let index = start; index < line.length - 1; index++) {
    const char = line[index]!;
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if ("{[(".includes(char)) depth++;
    if ("}])".includes(char)) depth--;
    if (char === "," && depth === 0) {
      items.push(line.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(line.slice(start, line.lastIndexOf("}")).trim());
  return [
    `  ${line.slice(0, open + 1)}`,
    ...items.map((item) => `    ${item},`),
    "  }",
  ].join("\n");
}

type GuideOptions = Pick<CompileOptions, "adapterRegistry"> & {
  library?: StandardLibrary;
};

/** The example's compiled root instrument, or the compiler's refusal. */
function compiledAttachment(
  source: string,
  attachment: string,
  options: GuideOptions,
) {
  const result = compile(source, {
    ...(options.library ? { standardLibrary: options.library } : {}),
    ...(options.adapterRegistry
      ? { adapterRegistry: options.adapterRegistry }
      : {}),
  });
  const document = result.artifacts?.document;
  if (!document)
    throw new Error(
      `${attachment} example does not compile: ${result.diagnostics.map((d) => d.message).join("; ")}`,
    );
  const instrumentId = document.objects
    .flatMap((object) => object.attachments)
    .find((candidate) => candidate.name === attachment)?.instrument;
  const instrument = document.instruments.find(
    (candidate) => candidate.id === instrumentId,
  );
  if (!instrument) throw new Error(`${attachment} example has no instrument`);
  return instrument;
}

function inputType(field: Record<string, unknown>) {
  const type = String(field.type);
  if (type === "list")
    return `list of ${String(field.item)}${field.maxItems === undefined ? "" : `, at most ${String(field.maxItems)}`}`;
  if (type === "ref" && field.target) return `ref to ${String(field.target)}`;
  if (type === "enum" && Array.isArray(field.values))
    return `one of ${field.values.join(", ")}`;
  return type;
}
