import {
  CompileFailure,
  didYouMean,
  fail,
  failWithCode,
} from "./diagnostics.ts";
import { hash as sha256 } from "fast-sha256";
import { buildUdlCostManifest, type UdlCostManifest } from "./cost.ts";
import {
  validateUdl,
  resolveField,
  sameObjectField,
  subjectPartyRoles,
  RESERVED_OBJECT_NAMES,
  type UdlObjectAttachment,
  type AttachmentPartyBinding,
  type SubjectPartyRole,
  udlObjectFieldSchema,
  udlInstrumentSchema,
  type UdlAction,
  type UdlActionSubject,
  type UdlAdapterSubjectSnapshot,
  type UdlCalculation,
  type UdlDocument,
  type UdlFamily,
  type UdlField,
  type UdlInstrument,
  type UdlObjectField,
  type UdlSelection,
  type UdlSubjectRequirement,
  type UdlValue,
} from "@hyperscale0/udl";
import {
  bindingDependencies,
  parameterDiagnostics,
  BindingContractError,
} from "./binding-contract.ts";
import { tunableBounds } from "./tunables.ts";
import { parseProgram } from "./parse.ts";
import { applyAttachmentEconomics } from "./attachment-economics.ts";
import { parseHeader } from "./header-source.ts";
import {
  lineColAt,
  type AssignmentDecl,
  type BlockExpr,
  type Diagnostic,
  type Entry,
  type Expr,
  type InstrumentDecl,
  type ObjectDecl,
  type Span,
} from "./ast.ts";
import { bundledStandardLibrary, type StandardLibrary } from "./std-library.ts";

import type { ProviderAdapter } from "@hyperscale0/adl";

export interface CompileDiagnostic extends Diagnostic {
  line: number;
  column: number;
  severity: "error";
  stage: "parse" | "check" | "lower";
}
export interface CompileOriginMapEntry {
  path: string;
  span: Span & { line: number; column: number };
  standardBlock?: { key: string; recordPath: string; headerDigest: string };
}
export interface AdapterBindingTarget {
  adapter: ProviderAdapter;
  operation: string;
}
export interface CompileOptions {
  standardLibrary?: StandardLibrary;
  adapterRegistry?: Readonly<Record<string, AdapterBindingTarget>>;
}
export interface CompileResult {
  verdict: "valid" | "invalid";
  diagnostics: CompileDiagnostic[];
  artifacts?: {
    document: UdlDocument;
    costManifest: UdlCostManifest;
    originMap: CompileOriginMapEntry[];
  };
}
function fieldType(row: Entry): { type: Expr; sensitive: boolean } {
  const type = row.value.kind === "default" ? row.value.type : row.value;
  if (type.kind !== "call" || type.name !== "sensitive")
    return { type, sensitive: false };
  if (type.args.length !== 1)
    fail(type, "sensitive needs one field type", "write sensitive(text)");
  return { type: type.args[0]!, sensitive: true };
}
function lowerFieldShape(
  row: Entry,
  resolveExpr: (e: Expr) => Expr = (e) => e,
): Record<string, unknown> {
  const { type: t, sensitive: isSensitive } = fieldType(row);
  if (t.kind === "block") {
    const b = entries(t);
    if (b.has("family") || b.has("target") || b.has("instrument")) {
      const tgt = b.get("instrument") ?? b.get("target");
      let target: string | string[] | undefined;
      if (tgt) {
        const resolved = resolveExpr(tgt);
        if (resolved.kind === "list") {
          const items = resolved.items.map((i) => text(resolveExpr(i)));
          target = items.length === 1 ? items[0] : items;
        } else {
          target = text(resolved);
        }
      }
      return {
        name: row.key,
        type: "ref",
        targetKind: "instrument",
        ...(target !== undefined ? { target } : {}),
        ...(isSensitive ? { sensitive: true } : {}),
      };
    }
  }
  const type = t.kind === "type" || t.kind === "call" ? t.name : text(t);
  const f: Record<string, unknown> = {
    name: row.key,
    type,
    ...(t.kind === "type" && t.optional ? { optional: true } : {}),
    ...(isSensitive ? { sensitive: true } : {}),
  };
  if (type === "enum" && t.kind === "call") {
    f.values = t.args.map(text);
  }
  if (type === "text" && t.kind === "call") {
    if (t.args.length < 2 || t.args.length > 3) {
      fail(
        t,
        "bounded text needs length bounds and an optional pattern",
        "write text(1, 80)",
      );
    }
    f.minLength = literal(resolveExpr(t.args[0]!));
    f.maxLength = literal(resolveExpr(t.args[1]!));
    if (t.args[2]) f.pattern = literal(resolveExpr(t.args[2]));
  }
  if (["integer", "money"].includes(type) && t.kind === "call") {
    if (t.args.length !== 2) {
      fail(
        t,
        "bounded fields need a minimum and maximum",
        "write integer(1, 12) or money(0 SAR, 100 SAR)",
      );
    }
    f.minimum = literal(resolveExpr(t.args[0]!));
    f.maximum = literal(resolveExpr(t.args[1]!));
  }
  if (
    t.kind === "call" &&
    !["enum", "text", "integer", "money", "list", "account"].includes(type)
  )
    fail(
      t,
      `unknown field constructor ${type}`,
      "use a field type without arguments",
    );
  if (type === "list" && t.kind === "call") {
    if (t.args.length < 1 || t.args.length > 2)
      fail(
        t,
        "list needs an item type and optional bound",
        "write list(text, 12)",
      );
    const item = t.args[0]!;
    f.item = item.kind === "type" ? item.name : text(item);
    if (item.kind === "type" && item.name === "ref") {
      f.target = item.target;
      f.targetKind = "object";
    }
    f.maxItems = t.args[1] ? literal(resolveExpr(t.args[1])) : 366;
  }
  if (type === "list" && t.kind === "type") {
    f.item = t.target;
    f.maxItems = 366;
  }
  if (type === "ref") {
    const target =
      t.kind === "type" ? t.target : (f.target as string | undefined);
    if (!target && t.kind !== "block") {
      fail(row, "reference needs a target", "write ref<object>");
    }
    f.targetKind = f.targetKind ?? "object";
    if (target) f.target = target;
  }
  return f;
}
function lowerObjectField(
  row: Entry,
  resolveExpr: (e: Expr) => Expr = (e) => e,
): UdlObjectField {
  const f = lowerFieldShape(row, resolveExpr);
  const constant =
    row.value.kind === "default" ? resolveExpr(row.value.value) : undefined;
  if (constant && !(constant.kind === "name" && constant.value === "runtime")) {
    f.value =
      f.type === "enum" && constant.kind === "name"
        ? constant.value
        : literal(constant, String(f.type));
  }
  const result = udlObjectFieldSchema.safeParse(f);
  if (!result.success)
    fail(
      row,
      result.error.message,
      "use a UDL object field type and its constraints",
    );
  return result.data;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

const emptyBlock: BlockExpr = {
  kind: "block",
  entries: [],
  span: { start: 0, end: 0 },
};
const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** Clock and parent actors run without a caller, so they have no public name. */
const automatic = (actor: UdlAction["actor"]) =>
  actor === "clock" ||
  (actor !== null && typeof actor === "object" && "parent" in actor);
const title = (name: string) =>
  name[0]!.toUpperCase() + name.slice(1).replaceAll("_", " ");
function entries(block: BlockExpr): Map<string, Expr> {
  const map = new Map<string, Expr>();
  for (const row of block.entries) {
    const previous = map.get(row.key);
    if (previous) {
      if (
        ![
          "requires",
          "moves",
          "invariants",
          "invoke",
          "calculate",
          "expose",
        ].includes(row.key)
      )
        fail(row, `duplicate ${row.key}`, "keep one value for this name");
      const items = (expr: Expr) =>
        expr.kind === "list" ? expr.items : [expr];
      map.set(row.key, {
        kind: "list",
        items: [...items(previous), ...items(row.value)],
        span: row.span,
      });
    } else map.set(row.key, row.value);
  }
  return map;
}
function asBlock(expr: Expr | undefined): BlockExpr {
  if (!expr) return emptyBlock;
  if (expr.kind !== "block")
    fail(expr, "expected a block", "write { name: value }");
  return expr;
}
function text(expr: Expr): string {
  if ("value" in expr && typeof expr.value === "string") return expr.value;
  return fail(
    expr,
    "expected a name or literal",
    "write a single name or literal",
  );
}
function decimal(raw: string, scale: number, expr: Expr): string {
  const [whole = "", fraction = ""] = raw.split(".");
  if (!/^\d+$/.test(whole) || fraction.length > scale)
    fail(
      expr,
      `literal has more than ${scale} decimal places`,
      `write at most ${scale} decimal places`,
    );
  return (
    BigInt(whole) * 10n ** BigInt(scale) +
    BigInt(fraction.padEnd(scale, "0") || "0")
  ).toString();
}
function literal(expr: Expr, expectedType?: string): string | number | boolean {
  if (expr.kind === "text" && expectedType === "duration")
    return literal({ ...expr, kind: "duration" });
  if (expr.kind === "money") {
    const [raw, currency] = expr.value.split(" ");
    if (currency !== "SAR")
      fail(
        expr,
        `currency ${currency} differs from SAR`,
        "write this amount in SAR",
      );
    const result = decimal(raw!, 2, expr);
    if (result.length > 18)
      fail(
        expr,
        "amount exceeds 18 minor-unit digits",
        "write a smaller amount",
      );
    return result;
  }
  if (expr.kind === "percent") {
    const n = Number(decimal(expr.value, 2, expr));
    if (n > 10000)
      fail(
        expr,
        "percentage exceeds 100%",
        "write a percentage from 0% to 100%",
      );
    return n;
  }
  if (expr.kind === "number") {
    const n = Number(expr.value);
    if (!Number.isSafeInteger(n))
      fail(
        expr,
        "expected a safe integer",
        "write an integer, a percentage, or an amount with SAR",
      );
    return n;
  }
  if (
    expr.kind === "duration" ||
    (expr.kind === "name" && /^P(?:\d|T)/.test(expr.value))
  ) {
    const short = /^(\d+)(ms|s|m|h|d|w)$/.exec(expr.value);
    const units: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60000,
      h: 3600000,
      d: 86400000,
      w: 604800000,
    };
    const iso =
      /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
        expr.value,
      );
    const n = short
      ? Number(short[1]) * units[short[2]!]!
      : iso
        ? Number(iso[1] ?? 0) * units.w! +
          Number(iso[2] ?? 0) * units.d! +
          Number(iso[3] ?? 0) * units.h! +
          Number(iso[4] ?? 0) * units.m! +
          Number(iso[5] ?? 0) * units.s!
        : NaN;
    if (!Number.isSafeInteger(n) || n <= 0)
      fail(
        expr,
        "invalid duration",
        "write a positive fixed duration such as 48h or 3d",
      );
    return n;
  }
  if (expr.kind === "date") {
    const raw =
      expr.value.length === 10 ? expr.value + "T00:00:00Z" : expr.value;
    const n = Date.parse(raw);
    const day = Date.parse(raw.slice(0, 10) + "T00:00:00Z");
    if (
      !Number.isFinite(n) ||
      !Number.isFinite(day) ||
      new Date(day).toISOString().slice(0, 10) !== raw.slice(0, 10)
    )
      fail(
        expr,
        "invalid date",
        "write a calendar date or a timestamp with an explicit offset",
      );
    return new Date(n).toISOString();
  }
  if (expr.kind === "text") return expr.value;
  if (expr.kind === "name" && ["true", "false"].includes(expr.value))
    return expr.value === "true";
  return fail(expr, "expected a literal", "write a typed constant");
}

export function compile(
  source: string,
  options: CompileOptions = {},
): CompileResult {
  const parsed = parseProgram(source);
  const sources = new Map([["program", source]]);
  const diagnostic = (
    d: Diagnostic,
    stage: CompileDiagnostic["stage"],
  ): CompileDiagnostic => ({
    ...d,
    ...lineColAt(sources.get(d.source ?? "program") ?? source, d.span.start),
    severity: "error",
    stage,
  });
  // A program instrument lowers once standalone and once per attachment, so
  // one authored mistake can fail each copy at the same place.
  const distinct = (list: Diagnostic[]) =>
    list.filter(
      (d, index) =>
        list.findIndex(
          (other) =>
            other.source === d.source &&
            other.span.start === d.span.start &&
            other.message === d.message,
        ) === index,
    );
  if (parsed.diagnostics.length)
    return {
      verdict: "invalid",
      diagnostics: parsed.diagnostics.map((d) => diagnostic(d, "parse")),
    };
  const program = parsed.program;
  const bindingDiagnostics: Diagnostic[] = [];
  const adapterTarget = (binding: string): AdapterBindingTarget | undefined => {
    const registry = options.adapterRegistry;
    if (!registry || !Object.hasOwn(registry, binding)) return;
    const target = registry[binding];
    return target &&
      Object.hasOwn(target.adapter.operationMap, target.operation)
      ? target
      : undefined;
  };
  try {
    if (program.header)
      fail(
        program,
        "compile a program, not a header",
        'start with program product_name "Title"',
      );
    if (program.currency !== "SAR")
      fail(
        program,
        "this release supports SAR",
        "write currency SAR or omit currency",
      );
    const templates = new Map<string, InstrumentDecl>();
    const declarationSources = new Map<InstrumentDecl, string>();
    const standardOrigins = new Map<
      InstrumentDecl,
      NonNullable<CompileOriginMapEntry["standardBlock"]>
    >();
    const requirementOrigins = new Map<
      UdlSubjectRequirement,
      { source: string; span: Span; message: string }
    >();
    const used = new Set<string>();
    for (const use of program.decls.filter((d) => d.kind === "use")) {
      if (used.has(use.name))
        fail(
          use,
          `header ${use.name} is used twice`,
          "remove the duplicate use line",
        );
      used.add(use.name);
      const content = (
        options.standardLibrary ?? bundledStandardLibrary
      ).source(use.name);
      if (!content)
        fail(use, `unknown header ${use.name}`, "choose a published header");
      sources.set(use.name, content);
      const bundled = bundledStandardLibrary.source(use.name);
      const headerDigest =
        bundled === content
          ? Array.from(sha256(new TextEncoder().encode(content)), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("")
          : undefined;
      let header;
      try {
        header = parseHeader(content, use.name);
      } catch (error) {
        if (!(error instanceof CompileFailure)) throw error;
        throw new CompileFailure({
          ...error.diagnostic,
          related: [
            {
              source: "program",
              span: use.span,
              message: `Imported header ${use.name}`,
            },
          ],
        });
      }
      const registerTemplates = (
        parentDecl: InstrumentDecl,
        prefix: string,
      ) => {
        if (templates.has(prefix))
          fail(
            parentDecl,
            `duplicate instrument ${prefix}`,
            "give each instrument a distinct name",
          );
        templates.set(prefix, parentDecl);
        declarationSources.set(parentDecl, use.name);
        if (headerDigest) {
          const [, root, ...record] = prefix.split(".");
          standardOrigins.set(parentDecl, {
            key: `${use.name}.${root}`,
            recordPath: record.join("."),
            headerDigest,
          });
        }
        const recs = entries(asBlock(entries(parentDecl.body).get("records")));
        for (const [recName, recBlock] of recs) {
          const recDecl: InstrumentDecl = {
            kind: "instrument",
            name: recName,
            parameters: [],
            body: asBlock(recBlock),
            span: parentDecl.span,
          };
          registerTemplates(recDecl, `${prefix}.${recName}`);
        }
      };
      for (const decl of header.decls)
        if (decl.kind === "instrument") {
          registerTemplates(decl, `${use.name}.${decl.name}`);
        }
    }
    for (const decl of program.decls)
      if (decl.kind === "instrument") templates.set(decl.name, decl);
    for (const decl of program.decls) {
      if (decl.kind === "instrument" && decl.parameters.length)
        fail(
          decl,
          "This compiler cannot instantiate a parameterized instrument declared inside a program.",
          "For this version, specialize the instrument with fixed bindings and remove its parameters. Custom reusable headers require a host-supplied library.",
        );
    }
    const document: UdlDocument = {
      udl: 4,
      version: 1,
      product: program.name,
      title: program.title,
      currency: "SAR",
      parties: Object.assign(Object.create(null) as UdlDocument["parties"], {
        programOperator: { kind: "business", role: "program_operator" },
        programTax: { kind: "business", role: "tax_payable" },
      }),
      objects: [],
      instruments: [],
    };
    const objects = new Map<string, ObjectDecl>();
    const assignments = new Map<string, AssignmentDecl>();
    const attachmentSubjects = new Map<string, string>();
    const names = new Set<string>();
    for (const decl of program.decls) {
      if (decl.kind === "expose" || decl.kind === "hide" || decl.kind === "use")
        continue;
      if (names.has(decl.name))
        fail(
          decl,
          `duplicate declaration ${decl.name}`,
          "give this declaration a distinct name",
        );
      names.add(decl.name);
      if (decl.kind === "object") {
        objects.set(decl.name, decl);
        for (const entry of decl.body.entries) {
          const match = /^attach\s+(\w+)\s*=\s*(.+)$/.exec(entry.key);
          if (!match) continue;
          const name = `${decl.name}_${match[1]}`;
          assignments.set(name, {
            kind: "assignment",
            name,
            target: match[2]!,
            body: asBlock(entry.value),
            span: entry.span,
          });
          attachmentSubjects.set(name, decl.name);
        }
      }
      if (decl.kind === "assignment") assignments.set(decl.name, decl);
      if (decl.kind === "party") {
        if (subjectPartyRoles.includes(decl.name as SubjectPartyRole))
          failWithCode(
            decl,
            "party_name_reserved",
            `${decl.name} is a reserved subject role`,
            "choose a party name other than owner, actor or operator",
          );
        if (!["person", "business", "staff"].includes(decl.partyKind))
          fail(
            decl,
            `unknown party kind ${decl.partyKind}`,
            "choose person, business, or staff",
          );
        document.parties[decl.name] = {
          kind: decl.partyKind as "person" | "business" | "staff",
          ...(decl.role ? { role: decl.role } : {}),
        };
      }
    }
    const origins: CompileOriginMapEntry[] = [];
    // Lowered objects lose their spans, so each keeps the expression that
    // produced it for the name check after lowering.
    const authored = new WeakMap<object, Expr>();
    const declarations = new WeakMap<UdlInstrument, InstrumentDecl>();
    const exposures: { instrument: string; action: string; entry: Entry }[] =
      [];
    const refundBindings = new Map<
      string,
      { parameter: string; span: Span; defaultState: string; action: string }[]
    >();
    const resolveFamily = (
      rawPath: string,
      expr: { span: Span; source?: string },
      required = true,
    ): UdlFamily | undefined => {
      const parts = rawPath.split(".");
      if (parts.length < 2) {
        if (!required) return undefined;
        failWithCode(
          expr,
          "HSX1001",
          `invalid family ${rawPath}`,
          "use module.instrument or module.instrument.record",
        );
      }
      const moduleName = parts[0]!;
      const exportPath = parts.slice(1).join(".");
      const targetTemplate = templates.get(rawPath);
      if (!targetTemplate) {
        if (!required) return undefined;
        failWithCode(
          expr,
          "HSX1001",
          `unknown family declaration ${rawPath}`,
          "choose a declared standard instrument",
        );
      }
      const topTemplate = templates.get(`${moduleName}.${parts[1]!}`);
      if (!topTemplate) {
        if (!required) return undefined;
        failWithCode(
          expr,
          "HSX1001",
          `unknown family declaration ${moduleName}.${parts[1]!}`,
          "choose a declared standard instrument",
        );
      }
      const topBody = entries(topTemplate.body);
      let revision: number | undefined;
      if (topBody.has("familyRevision")) {
        const val = literal(topBody.get("familyRevision")!);
        if (typeof val === "number") revision = val;
      }
      let currentBody = topTemplate.body;
      for (const recName of parts.slice(2)) {
        const recs = entries(asBlock(entries(currentBody).get("records")));
        const child = recs.get(recName);
        if (child) {
          currentBody = asBlock(child);
          const cBody = entries(currentBody);
          if (cBody.has("familyRevision")) {
            const val = literal(cBody.get("familyRevision")!);
            if (typeof val === "number") revision = val;
          }
        }
      }
      if (revision === undefined) {
        if (!required) return undefined;
        failWithCode(
          expr,
          "HSX1001",
          `declaration ${rawPath} has no familyRevision declared`,
          "declare familyRevision on the standard instrument",
        );
      }
      return { module: moduleName, exportPath, revision };
    };
    const addInstrument = (
      decl: InstrumentDecl,
      id: string,
      arguments_: BlockExpr,
      origin: Span,
      inherited = new Map<string, Expr>(),
      inheritedEnums = new Map<string, string[]>(),
      attachmentInfo?: {
        subjectKindId: string;
        attachmentName: string;
        renames: Map<string, string>;
        exposed: Map<string, string>;
        parties: Record<string, AttachmentPartyBinding>;
        attachments: UdlObjectAttachment[];
        economics: Entry[];
        child?: boolean;
      },
      familyDeclaration?: {
        module: string;
        exportPath: string;
        revision?: number | undefined;
      },
      standardOrigin?: NonNullable<CompileOriginMapEntry["standardBlock"]>,
    ) => {
      const resolveFamilyInstruments = (
        family: UdlFamily,
        currentInstId?: string,
        expr?: { span: Span; source?: string },
      ): string[] => {
        const found = new Set<string>();
        if (currentInstId && familyDeclaration) {
          if (
            family.module === familyDeclaration.module &&
            family.exportPath.startsWith(`${familyDeclaration.exportPath}.`)
          ) {
            const sub = family.exportPath
              .slice(familyDeclaration.exportPath.length + 1)
              .replaceAll(".", "_");
            found.add(`${currentInstId}_${sub}`);
          }
        }
        const topDeclName = family.exportPath.split(".")[0]!;
        const subRecordPath = family.exportPath.includes(".")
          ? family.exportPath.slice(topDeclName.length + 1).replaceAll(".", "_")
          : undefined;
        for (const asgn of assignments.values()) {
          if (asgn.target === `${family.module}.${topDeclName}`) {
            if (subRecordPath) {
              found.add(`${asgn.name}_${subRecordPath}`);
            } else {
              found.add(asgn.name);
            }
          }
        }
        for (const inst of document.instruments) {
          if (
            inst.family &&
            inst.family.module === family.module &&
            inst.family.exportPath === family.exportPath &&
            inst.family.revision === family.revision
          ) {
            found.add(inst.id);
          }
        }
        const result = [...found];
        if (result.length === 0 && expr) {
          failWithCode(
            expr,
            "HSX1001",
            `no instruments found for family ${family.module}.${family.exportPath}`,
            "declare an attachment matching this family",
          );
        }
        return result;
      };

      const collectChildExportPaths = (
        parentDecl: InstrumentDecl,
        suffix: string,
      ): string[] => {
        const recs = entries(asBlock(entries(parentDecl.body).get("records")));
        const matches: string[] = [];
        for (const [recName] of recs) {
          if (suffix === recName) matches.push(recName);
        }
        for (const [recName, recBlock] of recs) {
          if (suffix.startsWith(`${recName}_`)) {
            const nested = collectChildExportPaths(
              {
                kind: "instrument",
                name: recName,
                parameters: [],
                body: asBlock(recBlock),
                span: parentDecl.span,
              },
              suffix.slice(recName.length + 1),
            );
            for (const rest of nested) {
              matches.push(`${recName}.${rest}`);
            }
          }
        }
        return matches;
      };

      const resolveChildExportPath = (
        parentDecl: InstrumentDecl,
        suffix: string,
      ): string | undefined => {
        const matches = collectChildExportPaths(parentDecl, suffix);
        if (matches.length > 1) {
          failWithCode(
            parentDecl,
            "HSX1001",
            `ambiguous child export path suffix '${suffix}': multiple candidates (${matches.join(", ")})`,
            "rename conflicting records to remove duplicate export path suffixes",
          );
        }
        return matches[0];
      };

      const getInstrumentFamily = (targetId: string): UdlFamily | undefined => {
        const existing = document.instruments.find((i) => i.id === targetId);
        if (existing?.family) return existing.family;

        if (targetId.startsWith(`${id}_`) && familyDeclaration) {
          const sub = resolveChildExportPath(
            decl,
            targetId.slice(id.length + 1),
          );
          if (sub) {
            const fullExport = `${familyDeclaration.exportPath}.${sub}`;
            return resolveFamily(
              `${familyDeclaration.module}.${fullExport}`,
              { span: origin },
              false,
            );
          }
        }

        for (const [asgnName, asgn] of assignments) {
          if (targetId === asgnName || targetId.startsWith(`${asgnName}_`)) {
            const tmpl = templates.get(asgn.target);
            if (!tmpl) continue;
            const mod = declarationSources.get(tmpl);
            if (!mod || mod === "program") continue;
            if (targetId === asgnName) {
              return resolveFamily(asgn.target, asgn, false);
            } else {
              const sub = resolveChildExportPath(
                tmpl,
                targetId.slice(asgnName.length + 1),
              );
              if (sub) {
                const fullTarget = `${asgn.target}.${sub}`;
                return resolveFamily(fullTarget, asgn, false);
              }
            }
          }
        }
        return undefined;
      };

      const checkTargetFamily = (
        targetIds: unknown,
        expectedFamily: UdlFamily,
        expr: { span: Span; source?: string },
      ): void => {
        const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
        for (const tid of ids) {
          if (typeof tid !== "string")
            fail(
              expr,
              "instrument target needs a name",
              "name a declared instrument or a list of instruments",
            );
          const fam = getInstrumentFamily(tid);
          if (
            !fam ||
            fam.module !== expectedFamily.module ||
            fam.exportPath !== expectedFamily.exportPath ||
            fam.revision !== expectedFamily.revision
          ) {
            failWithCode(
              expr,
              "HSX1001",
              `target instrument ${tid} family does not match expected family ${expectedFamily.module}.${expectedFamily.exportPath} (revision ${expectedFamily.revision})`,
              "ensure target instrument matches the declared family",
            );
          }
        }
      };

      const enums = new Map(inheritedEnums);
      for (const parameter of decl.parameters) {
        const type =
          parameter.value.kind === "default"
            ? parameter.value.type
            : parameter.value;
        if (type.kind === "call" && type.name === "enum")
          enums.set(parameter.key, type.args.map(text));
      }
      const supplied = new Map<string, Expr>();
      for (const entry of arguments_.entries) {
        if (supplied.has(entry.key))
          fail(
            entry,
            `duplicate tunable ${entry.key}`,
            "supply each parameter once",
          );
        supplied.set(entry.key, entry.value);
      }
      const environment = new Map<string, Expr>(inherited);
      const parameterErrors: Diagnostic[] = [];
      for (const param of decl.parameters) {
        const type =
          param.value.kind === "default" ? param.value.type : param.value;
        const fallback =
          param.value.kind === "default" ? param.value.value : undefined;
        const typeName =
          type.kind === "type" || type.kind === "call" ? type.name : text(type);
        const partyParameter = attachmentInfo && typeName === "party";
        const byName: Expr | undefined =
          partyParameter &&
          (subjectPartyRoles.includes(param.key as SubjectPartyRole) ||
            document.parties[param.key])
            ? { kind: "name", value: param.key, span: origin }
            : undefined;
        const actual =
          supplied.get(param.key) ??
          byName ??
          (fallback && {
            ...fallback,
            source: declarationSources.get(decl) ?? "program",
          });
        if (!actual) {
          if (type.kind === "type" && type.optional) continue;
          parameterErrors.push({
            span: origin,
            code: partyParameter ? "subject_party_unbound" : "HSX1001",
            message: partyParameter
              ? `\`${param.key}\` has no binding. An attached ${param.key} must resolve to a subject role or an eligible declared party.`
              : `${id} needs ${param.key}`,
            fix: partyParameter
              ? `Use \`${param.key}: actor\` for the initiating customer or \`${param.key}: owner\` for the object owner. Declare a business for a fixed company counterparty.`
              : `add ${param.key}: value inside ${id}`,
            related: [
              {
                source: declarationSources.get(decl) ?? "program",
                span: param.span,
                message: `Parameter ${param.key}`,
              },
            ],
          });
          continue;
        }
        environment.set(param.key, actual);
      }
      let policyDiagnostics: ReturnType<typeof parameterDiagnostics>;
      let dependencies: ReturnType<typeof bindingDependencies>;
      try {
        policyDiagnostics = parameterDiagnostics(decl);
        dependencies = bindingDependencies(decl);
      } catch (error) {
        if (!(error instanceof BindingContractError)) throw error;
        throw new CompileFailure({
          code: "HSX1001",
          message: error.message,
          fix: "Repair the header binding contract.",
          span: error.entry.span,
          source: declarationSources.get(decl) ?? "program",
        });
      }
      for (const dependency of dependencies) {
        const selected = environment.get(dependency.when);
        if (
          selected?.kind === "name" &&
          selected.value === dependency.is &&
          !environment.has(dependency.binding)
        ) {
          throw new CompileFailure({
            code: "HSX1001",
            message: dependency.message.replaceAll(
              "{attachment}",
              attachmentInfo?.attachmentName ?? id,
            ),
            fix: dependency.fix,
            span: origin,
            related: [
              {
                source: declarationSources.get(decl) ?? "program",
                span: dependency.span,
                message: "Conditional binding requirement",
              },
            ],
          });
        }
      }
      for (const key of supplied.keys()) {
        if (decl.parameters.some((p) => p.key === key)) continue;
        const suppliedValue = supplied.get(key)!;
        const requirements = decl.body.entries
          .filter((entry) => entry.key.startsWith("action "))
          .flatMap(
            (entry) =>
              asBlock(entries(asBlock(entry.value)).get("subject")).entries,
          );
        const moneyFields = [
          ...new Set(
            requirements
              .filter((entry) => {
                const type = entry.value;
                return type.kind === "name"
                  ? type.value === "money"
                  : (type.kind === "type" || type.kind === "call") &&
                      type.name === "money";
              })
              .map((entry) => entry.key),
          ),
        ];
        if (
          attachmentInfo &&
          (suppliedValue.kind === "money" || suppliedValue.kind === "name") &&
          moneyFields.length === 1
        ) {
          const field = moneyFields[0]!;
          const object = objects.get(attachmentInfo.subjectKindId)!;
          const candidates = asBlock(
            entries(object.body).get("fields"),
          ).entries.filter((entry) =>
            entry.value.kind === "name"
              ? entry.value.value === "money"
              : (entry.value.kind === "type" || entry.value.kind === "call") &&
                entry.value.name === "money",
          );
          const target =
            candidates.length === 1 ? candidates[0]!.key : "yourMoneyField";
          fail(
            suppliedValue,
            `\`${assignments.get(id)?.target ?? decl.name}\` has no \`${key}\` tunable. Its actions require the object's \`${field}\` field.`,
            `Remove \`${key}\`. To use your object's money field, add \`rename { ${field}: ${target} }\`.`,
          );
        }
        fail(
          suppliedValue,
          `unknown tunable ${key}`,
          `choose ${decl.parameters.map((p) => p.key).join(", ")}`,
        );
      }
      const isParty = (name: string) =>
        !!document.parties[name] ||
        (!!attachmentInfo &&
          subjectPartyRoles.includes(name as SubjectPartyRole));
      const resolvedParties = new Set<string>();
      const resolve = (
        expr: Expr,
        seen = new Set<string>(),
        partyBinding = false,
      ): Expr => {
        if (
          expr.kind === "call" &&
          ["object", "all", "party"].includes(expr.name)
        ) {
          if (expr.args.length !== 1)
            fail(
              expr,
              `${expr.name} needs one type`,
              "supply one declared object or party kind",
            );
          const type = text(expr.args[0]!);
          const matches =
            expr.name === "party"
              ? Object.entries(document.parties)
                  .filter(
                    ([name, party]) =>
                      party.kind === type && (!partyBinding || names.has(name)),
                  )
                  .map(([name]) => name)
              : [...assignments.values()]
                  .filter(
                    (assignment) =>
                      expr.name === "all" ||
                      !attachmentSubjects.has(assignment.name) ||
                      attachmentSubjects.get(assignment.name) ===
                        attachmentInfo?.subjectKindId,
                  )
                  .filter(
                    (assignment) =>
                      assignment.target === type ||
                      type.startsWith(`${assignment.target}.`),
                  )
                  .map(
                    (assignment) =>
                      assignment.name +
                      type.slice(assignment.target.length).replaceAll(".", "_"),
                  );
          if (
            expr.name === "object" &&
            matches.length !== 1 &&
            attachmentInfo
          ) {
            const parameter =
              [...environment].find(([, value]) => value === expr)?.[0] ??
              decl.parameters.find(
                (p) =>
                  p.value.kind === "default" &&
                  p.value.value.span.start === expr.span.start,
              )?.key ??
              "reference";
            const local = (name: string) =>
              attachmentSubjects.has(name)
                ? name.slice(attachmentInfo.subjectKindId.length + 1)
                : `${name} (program)`;
            const target = templates.get(type);
            const required =
              target?.parameters
                .filter(
                  (p) =>
                    p.value.kind !== "default" &&
                    !(p.value.kind === "type" && p.value.optional),
                )
                .map((p) => p.key) ?? [];
            fail(
              { span: origin },
              `Attachment \`${attachmentInfo.attachmentName}\` needs a \`${parameter}\` binding. ${
                matches.length === 0
                  ? `No \`${type}\` attachment exists on \`${attachmentInfo.subjectKindId}\`.`
                  : `Several \`${type}\` attachments match on \`${attachmentInfo.subjectKindId}\`: ${matches.map(local).join(", ")}.`
              }`,
              matches.length
                ? `Bind \`${parameter}\` explicitly to one of: ${matches.map(local).join(", ")}.`
                : `Declare a ${parameter} attachment and bind \`${parameter}: allowance\`. Choose ${required.map((name) => (name.startsWith("per_") ? `its ${name.slice(4).replaceAll("_", " ")} limit` : `\`${name}\``)).join(", ") || "its required bindings"} explicitly.`,
            );
          }
          if (expr.name !== "all" && matches.length !== 1)
            failWithCode(
              expr,
              partyBinding ? "subject_party_unbound" : "HSX1001",
              `${id} needs ${expr.name === "all" ? "at least one" : "exactly one"} ${type}`,
              "declare the required object or supply this tunable explicitly",
            );
          const items: Expr[] = matches.map((value) => ({
            kind: "name",
            value,
            span: origin,
          }));
          return expr.name === "all"
            ? { kind: "list", items, span: origin }
            : items[0]!;
        }
        if (expr.kind !== "name") return expr;
        const binding = environment.get(expr.value);
        if (
          attachmentInfo &&
          subjectPartyRoles.includes(expr.value as SubjectPartyRole) &&
          (!binding ||
            (binding.kind === "name" && binding.value === expr.value))
        )
          return expr;
        // A resolved party parameter or an own parameter bound to a value takes
        // precedence over a same-named sibling attachment; `limits: limits`
        // binds by identity and still names the sibling.
        if (attachmentInfo && !resolvedParties.has(expr.value)) {
          const [local, ...tail] = expr.value.split(".");
          const own = environment.get(local!);
          const ownValue =
            own !== undefined && !(own.kind === "name" && own.value === local);
          const target = `${attachmentInfo.subjectKindId}_${local}`;
          if (!ownValue && attachmentSubjects.has(target))
            return { ...expr, value: [target, ...tail].join("_") };
        }
        if (expr.value.startsWith("party.")) {
          const [, party, ...members] = expr.value.split(".");
          const binding = environment.get(party!);
          if (binding?.kind === "name" && isParty(binding.value))
            return {
              ...expr,
              value: ["party", binding.value, ...members].join("."),
            };
        }
        const [root, ...tail] = expr.value.split(".");
        const bound = environment.get(root!);
        if (!bound || (bound.kind === "name" && bound.value === root))
          return expr;
        if (seen.has(root!))
          return failWithCode(
            expr,
            partyBinding ? "subject_party_unbound" : "HSX1001",
            `cyclic tunable ${root}`,
            "replace the cycle with a literal or declared reference",
          );
        let resolved =
          resolvedParties.has(root!) ||
          (!partyBinding &&
            (supplied.has(root!) || inherited.has(root!) || enums.has(root!)))
            ? bound
            : resolve(bound, new Set([...seen, root!]), partyBinding);
        for (const key of tail) {
          if (resolved.kind !== "block") return expr;
          const child = entries(resolved).get(key);
          if (!child)
            return fail(
              expr,
              `missing tunable ${expr.value}`,
              `declare ${key} in ${root}`,
            );
          resolved = resolve(child, new Set([...seen, root!]), partyBinding);
        }
        return resolved;
      };
      for (const param of decl.parameters) {
        try {
          const actual = environment.get(param.key);
          if (!actual) continue;
          const t =
            param.value.kind === "default" ? param.value.type : param.value;
          const type =
            t.kind === "type" || t.kind === "call" ? t.name : text(t);
          const asWritten =
            (supplied.has(param.key) && !attachmentInfo) || type === "enum";
          let v = asWritten
            ? actual
            : resolve(actual, new Set(), !!attachmentInfo && type === "party");
          if (
            type === "duration" &&
            (v.kind === "text" || v.kind === "name") &&
            /^P/.test(v.value)
          )
            v = { ...v, kind: "duration" };
          environment.set(param.key, v);
          if (type === "enum" && t.kind === "call") {
            if (v.kind !== "name" || !t.args.some((a) => text(a) === v.value))
              fail(
                v,
                `invalid ${param.key}`,
                `choose ${t.args.map(text).join(", ")}`,
              );
          } else if (type === "list") {
            if (v.kind !== "list")
              fail(v, `${param.key} needs a list`, "write [value, value]");
          } else if (type === "party") {
            if (v.kind !== "name" || !isParty(v.value))
              failWithCode(
                actual,
                attachmentInfo ? "subject_party_unbound" : "HSX1001",
                attachmentInfo
                  ? `\`${param.key}: ${"value" in actual && typeof actual.value === "string" ? actual.value : param.key}\` has no binding. An attached ${param.key} must resolve to a subject role or an eligible declared party.`
                  : `${param.key} needs a declared party`,
                attachmentInfo
                  ? `Use \`${param.key}: actor\` for the initiating customer or \`${param.key}: owner\` for the object owner. Declare a business for a fixed company counterparty.`
                  : "declare a party and use its name here",
              );
            const party = document.parties[v.value];
            if (
              (party?.kind === "staff" && !party.role) ||
              (attachmentInfo && party?.kind === "person")
            )
              failWithCode(
                actual,
                "party_kind_mismatch",
                party?.kind === "person"
                  ? `\`${v.value}\` is a declared person. Attachments resolve customer identity through \`owner\` or \`actor\`, rather than a fixed person declaration.`
                  : `\`${v.value}\` is declared staff without a permission role.`,
                "Replace this binding with the appropriate subject role. Use declared businesses for fixed counterparties and permission-bearing staff roles for authorized actions.",
              );
            resolvedParties.add(param.key);
            if (attachmentInfo)
              attachmentInfo.parties[param.key] = subjectPartyRoles.includes(
                v.value as SubjectPartyRole,
              )
                ? { role: v.value as SubjectPartyRole }
                : { party: v.value };
          } else if (type === "ref") {
            // Listed objects resolve like a single binding, so `on: [plan]`
            // names the sibling attachment that `on: plan` names.
            const values =
              v.kind !== "list"
                ? [v]
                : asWritten
                  ? v.items
                  : v.items.map((item) => resolve(item));
            if (v.kind === "list")
              environment.set(param.key, { ...v, items: values });
            if (v.kind === "list" && (t.kind !== "type" || !t.many))
              fail(
                v,
                `${param.key} accepts one reference`,
                "use one object name",
              );
            if (!values.length || values.length > 16)
              fail(
                v,
                "reference union needs 1 to 16 objects",
                "use at most 16 distinct object names",
              );
            const seen = new Set<string>();
            for (const value of values) {
              if (value.kind !== "name")
                fail(
                  value,
                  "reference needs an object name",
                  "name a declared object",
                );
              let targetType = objects.get(value.value)?.name;
              const candidates = [
                ...[...assignments.values()].map(
                  (assignment) => [assignment.name, assignment.target] as const,
                ),
                ...program.decls
                  .filter((decl) => decl.kind === "instrument")
                  .map((decl) => [decl.name, decl.name] as const),
              ];
              for (const [instance, target] of candidates) {
                if (value.value === instance) {
                  targetType = target;
                  break;
                }
                if (
                  !value.value.startsWith(`${instance}.`) &&
                  !value.value.startsWith(`${instance}_`)
                )
                  continue;
                const template = templates.get(target);
                if (!template) continue;
                const suffix = value.value
                  .slice(instance.length + 1)
                  .replaceAll(".", "_");
                const child = resolveChildExportPath(template, suffix);
                if (child) targetType = `${target}.${child}`;
              }
              if (
                !targetType ||
                (t.kind === "type" && t.target && targetType !== t.target)
              )
                fail(
                  value,
                  `${param.key} has the wrong object type`,
                  `use an object of type ${t.kind === "type" ? t.target : "ref"}`,
                );
              if (seen.has(value.value))
                fail(value, "duplicate reference", "list each object once");
              seen.add(value.value);
            }
            // A many-reference tunable is a list even when one object is bound,
            // so report datasets and other value positions never see a bare name.
            if (t.kind === "type" && t.many && v.kind !== "list")
              environment.set(param.key, {
                kind: "list",
                items: [v],
                span: v.span,
              });
          } else if (type === "fee" || type === "split" || type === "policy") {
            if (v.kind !== "block")
              fail(
                v,
                `${param.key} needs a block`,
                `write ${param.key} { ... }`,
              );
          } else if (
            type === "money" ||
            type === "percent" ||
            type === "date" ||
            type === "duration" ||
            type === "integer" ||
            type === "text" ||
            type === "boolean"
          ) {
            const bounds = tunableBounds(t);
            if (v.kind === "name" && v.value === "runtime") continue;
            const expected =
              type === "integer"
                ? "number"
                : type === "boolean"
                  ? "name"
                  : type;
            if (
              v.kind !== expected ||
              (type === "boolean" &&
                v.kind === "name" &&
                !["true", "false"].includes(v.value))
            ) {
              if (type === "money" && v.kind === "name" && attachmentInfo) {
                const target = v.value.replace(/^subject\./, "");
                const fallback =
                  param.value.kind === "default"
                    ? param.value.value
                    : undefined;
                const advice =
                  fallback?.kind === "name" && fallback.value === "runtime"
                    ? `omit \`${param.key}\``
                    : `set \`${param.key}: runtime\``;
                fail(
                  v,
                  `\`${param.key}\` cannot read \`${v.value}\` as a tunable. This position accepts a fixed money amount or a runtime amount.`,
                  `For a varying deposit, ${advice} and add \`rename { ${param.key}: ${target} }\`. Use a literal only for a fixed charge.`,
                );
              }
              if (type === "money" && v.kind === "percent") {
                const policy = policyDiagnostics.find(
                  (policy) => policy.parameter === param.key,
                );
                fail(
                  v,
                  `\`${assignments.get(id)?.target ?? decl.name}.${param.key}\` accepts ${policy?.accepts ?? "a fixed amount"}. It cannot express ${policy?.percentage ?? "a percentage-based charge"}.`,
                  policy?.fix ??
                    "Use a fixed amount only if that is the intended policy. A percentage charge needs an authored rate calculation; do not approximate it with a cash amount.",
                );
              }
              fail(v, `${param.key} needs ${type}`, `write a ${type} literal`);
            }
            try {
              const value = literal(v);
              if (
                bounds &&
                (BigInt(String(value)) < BigInt(bounds.minimum) ||
                  BigInt(String(value)) > BigInt(bounds.maximum))
              )
                fail(
                  v,
                  `${param.key} is outside ${bounds.minimum}..${bounds.maximum}`,
                  "choose a value inside the tunable's bounds",
                );
            } catch (error) {
              if (error instanceof CompileFailure)
                fail(
                  v,
                  `${param.key}: ${error.diagnostic.message}`,
                  error.diagnostic.fix,
                );
              throw error;
            }
          } else {
            fail(
              t,
              `unknown tunable type ${type}`,
              "use a declared HSX tunable type",
            );
          }
        } catch (error) {
          if (!(error instanceof CompileFailure)) throw error;
          const related = [
            {
              source: declarationSources.get(decl) ?? "program",
              span: param.span,
              message: `Parameter ${param.key}`,
            },
          ];
          const actual = supplied.get(param.key);
          const party =
            actual?.kind === "name"
              ? program.decls.find(
                  (entry) =>
                    entry.kind === "party" && entry.name === actual.value,
                )
              : undefined;
          if (party?.kind === "party")
            related.push({
              source: "program",
              span: party.span,
              message: `Declared party ${party.name}`,
            });
          parameterErrors.push({ ...error.diagnostic, related });
        }
      }
      if (parameterErrors.length) {
        bindingDiagnostics.push(...parameterErrors.slice(1));
        throw new CompileFailure(parameterErrors[0]!);
      }
      const body = entries(decl.body);
      for (const constraint of asBlock(body.get("constraints")).entries) {
        const rule = constraint.value;
        if (
          rule.kind !== "call" ||
          rule.args.length !== 1 ||
          !["less_than", "at_most", "greater_than"].includes(rule.name)
        )
          fail(
            rule,
            "invalid tunable constraint",
            "use less_than(name), at_most(name), or greater_than(name)",
          );
        const left = environment.get(constraint.key),
          right = environment.get(text(rule.args[0]!));
        if (!left || !right)
          fail(
            rule,
            "constraint needs two declared tunables",
            "name the compared tunables",
          );
        const numericKind = (expr: Expr) =>
          expr.kind === "name" && /^P/.test(expr.value)
            ? "duration"
            : expr.kind;
        if (
          !["money", "number", "percent", "duration"].includes(
            numericKind(left),
          ) ||
          numericKind(left) !== numericKind(right)
        )
          fail(
            rule,
            "constraint needs numeric tunables of the same type",
            "compare two amounts, integers, percentages or durations",
          );
        const a = BigInt(String(literal(left))),
          b = BigInt(String(literal(right)));
        if (
          !(rule.name === "less_than"
            ? a < b
            : rule.name === "at_most"
              ? a <= b
              : a > b)
        )
          fail(
            left,
            `${constraint.key} must be ${rule.name} ${text(rule.args[0]!)}`,
            "choose values satisfying the header constraint",
          );
      }
      for (const key of body.keys())
        if (
          ![
            "familyRevision",
            "fields",
            "lifecycle",
            "records",
            "summary",
            "invariants",
            "constraints",
            "dependencies",
            "parameterDiagnostics",
            "reports",
            "revisioned",
            "scope",
          ].includes(key) &&
          !key.startsWith("action ")
        )
          fail(
            decl,
            `unknown instrument clause ${key}`,
            "use fields, lifecycle, actions, invariants, or records",
          );
      if (body.has("familyRevision")) {
        const revExpr = body.get("familyRevision")!;
        const revVal = literal(revExpr);
        if (
          typeof revVal !== "number" ||
          !Number.isInteger(revVal) ||
          revVal <= 0
        ) {
          fail(
            revExpr,
            "familyRevision must be a positive integer",
            "use a positive integer revision",
          );
        }
        if (familyDeclaration) {
          familyDeclaration.revision = revVal;
        }
      }
      const records = entries(asBlock(body.get("records")));
      if (!inherited.size)
        environment.set("parent", { kind: "name", value: id, span: origin });
      for (const key of records.keys())
        if (!decl.parameters.some((parameter) => parameter.key === key))
          environment.set(key, {
            kind: "name",
            value: `${id}_${key}`,
            span: origin,
          });
      const fields: UdlField[] = [];
      const calculations: UdlCalculation[] = [];
      let currentAction: UdlAction | undefined;
      let currentActionName: string | undefined;
      const path = (expr: Expr): string => {
        const value = resolve(expr);
        const name = text(value);
        if (isParty(name)) return `party.${name}`;
        if (name.startsWith("subject.")) {
          const subField = name.split(".")[1]!;
          if (currentAction) {
            const req = currentAction.subject?.requirements.find(
              (r) => r.field.name === subField,
            );
            if (!req) {
              failWithCode(
                expr,
                "subject_field_unknown",
                `subject.${subField} names no declared subject requirement in action ${currentActionName}`,
                `declare ${subField} in subject { ... }`,
              );
            }
          } else {
            const declaredInAction = decl.body.entries.some((e) => {
              if (!e.key.startsWith("action ")) return false;
              const subBlock = entries(asBlock(e.value)).get("subject");
              if (!subBlock) return false;
              return asBlock(subBlock).entries.some((se) => {
                if (se.key === subField) return true;
                if (se.key === "adapter") {
                  const names =
                    se.value.kind === "list"
                      ? se.value.items.map(text)
                      : [text(se.value)];
                  return names.some((n) => {
                    const reg = adapterTarget(n);
                    if (!reg) return false;
                    const op = reg.adapter.operationMap[reg.operation];
                    return op?.subjectRequirements?.some(
                      (sr) => sr.name === subField,
                    );
                  });
                }
                return false;
              });
            });
            if (!declaredInAction) {
              failWithCode(
                expr,
                "subject_field_unknown",
                `subject.${subField} names no declared subject requirement in instrument ${id}`,
                `declare ${subField} in an action subject { ... }`,
              );
            }
          }
        }
        return /^(self|input|party|subject)\./.test(name)
          ? name
          : `self.${name}`;
      };
      const val = (expr: Expr): UdlValue => {
        const v = resolve(expr);
        if (v.kind !== "name" || ["true", "false"].includes(v.value))
          return { literal: literal(v) };
        const value = { field: path(v) };
        authored.set(value, expr);
        return value;
      };
      const data = (expr: Expr): unknown => {
        if (
          expr.kind === "call" &&
          expr.name === "current" &&
          !expr.args.length
        )
          return id;
        const value = resolve(expr);
        if (value.kind === "block") {
          const rawEntries = entries(value);
          if (
            (rawEntries.has("family") && !rawEntries.has("kind")) ||
            ((rawEntries.has("states") ||
              rawEntries.has("reference") ||
              rawEntries.has("anchor")) &&
              rawEntries.has("instrument"))
          ) {
            let famTuple: UdlFamily | undefined;
            if (rawEntries.has("family")) {
              const famExpr = rawEntries.get("family")!;
              const famStr =
                famExpr.kind === "name" ? famExpr.value : text(famExpr);
              famTuple = resolveFamily(famStr, famExpr);
            }

            let instrumentVal: unknown;
            if (rawEntries.has("instrument")) {
              instrumentVal = data(rawEntries.get("instrument")!);
              if (famTuple) {
                checkTargetFamily(
                  instrumentVal,
                  famTuple,
                  rawEntries.get("instrument")!,
                );
              }
            } else if (famTuple) {
              const matched = resolveFamilyInstruments(
                famTuple,
                id,
                rawEntries.get("family")!,
              );
              instrumentVal = matched.length === 1 ? matched[0] : matched;
            }

            const result: Record<string, unknown> = {};
            if (famTuple) {
              result.family = famTuple;
            }
            if (instrumentVal !== undefined) {
              result.instrument = instrumentVal;
            }
            for (const [k, v] of rawEntries) {
              if (k === "family" || k === "instrument") continue;
              result[k] = data(v);
            }
            authored.set(result, value);
            return result;
          }

          const result = Object.fromEntries(
            [...rawEntries].map(([key, value]) => [key, data(value)]),
          );
          const selection = result.selection as
            | { instrument?: unknown }
            | undefined;
          if (
            Array.isArray(selection?.instrument) &&
            selection.instrument.length === 0
          ) {
            if (result.op === "aggregate")
              return {
                target: result.target,
                op: "sum",
                values: [{ literal: result.measure === "count" ? 0 : "0" }],
              };
            if (result.kind === "aggregate")
              return {
                kind: "compare",
                left: { literal: result.measure === "count" ? 0 : "0" },
                operator: result.operator,
                right: result.value,
              };
            return null;
          }
          authored.set(result, value);
          return result;
        }
        if (value.kind === "list") {
          const items = value.items.map(data).filter((item) => item !== null);
          authored.set(items, value);
          return items;
        }
        if (
          value.kind === "call" &&
          value.name === "child" &&
          value.args.length === 2
        ) {
          const parent = resolve(value.args[0]!);
          const child = (item: Expr) =>
            `${text(item).replaceAll(".", "_")}_${text(value.args[1]!)}`;
          return parent.kind === "list"
            ? parent.items.map(child)
            : child(parent);
        }
        if (value.kind === "name")
          return value.value === "true" || value.value === "false"
            ? value.value === "true"
            : value.value;
        return literal(value);
      };
      const lowerFields = (block: BlockExpr): UdlField[] => {
        const result: UdlField[] = [];
        for (const row of block.entries) {
          const { type: t } = fieldType(row);
          const constant =
            row.value.kind === "default" ? resolve(row.value.value) : undefined;
          const f = lowerFieldShape(row, resolve);
          const type = f.type;
          if (type === "list" && t.kind === "call") {
            const item = t.args[0]!;
            if (item.kind === "type" && item.name === "ref" && item.target) {
              f.target = text(
                resolve({ kind: "name", value: item.target, span: item.span }),
              ).replaceAll(".", "_");
              f.targetKind = objects.has(String(f.target))
                ? "object"
                : "instrument";
            }
          }
          if (type === "ref") {
            if (t.kind === "block") {
              const b = entries(t);
              const famNode = b.get("targetFamily") ?? b.get("family");
              let targetFamTuple: UdlFamily | undefined;
              if (famNode) {
                const famStr =
                  famNode.kind === "name" ? famNode.value : text(famNode);
                targetFamTuple = resolveFamily(famStr, famNode);
                f.targetFamily = targetFamTuple;
              }
              if (b.has("target") || b.has("instrument")) {
                const tgtExpr = (b.get("target") ?? b.get("instrument"))!;
                const resolvedTgt = resolve(tgtExpr);
                let tgtVal: string | string[];
                if (resolvedTgt.kind === "list") {
                  const items = resolvedTgt.items.map((it) =>
                    text(resolve(it)).replaceAll(".", "_"),
                  );
                  tgtVal = items.length === 1 ? items[0]! : items;
                } else {
                  tgtVal = text(resolvedTgt).replaceAll(".", "_");
                }
                f.target = tgtVal;
                if (targetFamTuple) {
                  checkTargetFamily(tgtVal, targetFamTuple, tgtExpr);
                }
              } else if (targetFamTuple) {
                const matched = resolveFamilyInstruments(
                  targetFamTuple,
                  id,
                  famNode!,
                );
                f.target = matched.length === 1 ? matched[0] : matched;
              }
              f.targetKind =
                typeof f.target === "string" && objects.has(f.target)
                  ? "object"
                  : "instrument";
            } else {
              const target = t.kind === "type" ? t.target : undefined;
              if (!target)
                fail(row, "reference needs a target", "write ref<object>");
              const [root, ...tail] = target.split(".");
              const resolved = environment.get(root!);
              // An optional field pointing at an unsupplied optional tunable
              // has nothing to point at, so the instrument drops it.
              if (
                !resolved &&
                f.optional &&
                decl.parameters.some((parameter) => parameter.key === root)
              )
                continue;
              const resolvedTargets =
                resolved?.kind === "list"
                  ? resolved.items
                  : resolved
                    ? [resolved]
                    : [];
              const targets = resolvedTargets.map((value) =>
                [text(resolve(value)).replaceAll(".", "_"), ...tail].join("_"),
              );
              f.target =
                target === "self"
                  ? id
                  : targets.length === 1
                    ? targets[0]
                    : targets.length
                      ? targets
                      : target;
              f.targetKind =
                typeof f.target === "string" && objects.has(f.target)
                  ? "object"
                  : "instrument";
            }
          } else if (type === "account") {
            if (t.kind === "call") {
              if (t.args.length < 1 || t.args.length > 4)
                fail(
                  t,
                  "account needs an owner, optional book, mode and key",
                  "write account(buyer, claim, contra)",
                );
              const owner = t.args[0]!;
              if (owner.kind === "call" && owner.name === "adapter") {
                if (owner.args.length !== 1)
                  fail(
                    owner,
                    "adapter needs one binding",
                    'write account(adapter(binding), cash, "premium")',
                  );
                f.owner = { adapter: text(resolve(owner.args[0]!)) };
              } else f.owner = text(resolve(owner));
              f.book = t.args[1] ? text(t.args[1]) : "cash";
              if (t.args[2]) {
                const mode = text(t.args[2]);
                if (mode === "contra") f.contra = true;
                else f.key = mode;
              }
              if (t.args[3]) f.key = text(t.args[3]);
            } else if (t.kind === "type" && t.owner) {
              f.owner =
                t.owner === "self"
                  ? "self"
                  : text(
                      resolve({ kind: "name", value: t.owner, span: row.span }),
                    );
              f.book = "cash";
            } else
              fail(
                row,
                "account needs an owner",
                "write account of buyer or account of self",
              );
          }
          if (
            constant &&
            !(constant.kind === "name" && constant.value === "runtime")
          ) {
            if (constant.kind === "call") {
              const args =
                constant.name === "aggregate" ? [] : constant.args.map(val);
              const target = row.key;
              if (constant.name === "aggregate" && constant.args.length === 2)
                calculations.push({
                  target,
                  op: "aggregate",
                  selection: data(
                    constant.args[0]!,
                  ) as import("@hyperscale0/udl").UdlSelection,
                  measure:
                    text(constant.args[1]!) === "count"
                      ? "count"
                      : { sum: text(constant.args[1]!) },
                });
              else if (constant.name === "at" && args.length === 2)
                calculations.push({
                  target,
                  op: "at",
                  list: path(constant.args[0]!),
                  position: args[1]!,
                });
              else if (constant.name === "ratio" && args.length === 3)
                calculations.push({
                  target,
                  op: "ratio",
                  amount: args[0]!,
                  numerator: args[1]!,
                  denominator: args[2]!,
                  rounding: "floor",
                });
              else if (constant.name === "rate" && args.length === 2)
                calculations.push({
                  target,
                  op: "rate",
                  base: args[0]!,
                  bps: args[1]!,
                  rounding: "floor",
                });
              else if (constant.name === "sum" || constant.name === "minimum")
                calculations.push({ target, op: constant.name, values: args });
              else if (constant.name === "subtract" && args.length >= 2)
                calculations.push({
                  target,
                  op: "subtract",
                  base: args[0]!,
                  subtract: args.slice(1),
                });
              else if (constant.name === "multiply" && args.length === 2)
                calculations.push({
                  target,
                  op: "multiply",
                  amount: args[0]!,
                  units: args[1]!,
                });
              else if (constant.name === "divide" && args.length === 2)
                calculations.push({
                  target,
                  op: "divide",
                  amount: args[0]!,
                  divisor: args[1]!,
                  rounding: "floor",
                });
              else if (
                ["before", "after"].includes(constant.name) &&
                args.length === 2
              )
                calculations.push({
                  target,
                  op: "shift",
                  date: args[0]!,
                  milliseconds: args[1]!,
                  direction: constant.name as "before" | "after",
                });
              else
                fail(
                  constant,
                  `unknown calculation ${constant.name}`,
                  "use rate, sum, minimum, subtract, multiply, divide, before or after",
                );
              authored.set(calculations.at(-1)!, constant);
            } else if (type === "enum" && constant.kind === "name")
              f.value = constant.value;
            else if (type === "money" && constant.kind === "name")
              calculations.push({
                target: row.key,
                op: "sum",
                values: [val(constant)],
              });
            else f.value = literal(constant, String(type));
          }
          authored.set(f, row.value);
          result.push(f as UdlField);
        }
        return result;
      };
      fields.push(...lowerFields(asBlock(body.get("fields"))));
      const lifecycleBlock = asBlock(body.get("lifecycle"));
      const lifecycle = data(lifecycleBlock) as UdlInstrument["lifecycle"];
      const states = Array.isArray(lifecycle.states) ? lifecycle.states : [];
      const checkState = (expr: Expr, state: unknown) => {
        if (typeof state !== "string" || !states.length) return;
        if (states.includes(state)) return;
        fail(
          expr,
          `\`${state}\` is not a state of \`${decl.name}\`.${didYouMean(state, states)}`,
          `Use one of ${states.join(", ")}, or add \`${state}\` to \`lifecycle.states\`.`,
        );
      };
      const initialExpr = entries(lifecycleBlock).get("initial");
      if (initialExpr) checkState(initialExpr, lifecycle.initial);
      lifecycle.transitions = Object.create(
        null,
      ) as UdlInstrument["lifecycle"]["transitions"];
      const inst: UdlInstrument = {
        id,
        ...(attachmentInfo ? { subject: attachmentInfo.subjectKindId } : {}),
        title: title(id),
        summary: body.has("summary")
          ? String(data(body.get("summary")!))
          : title(id),
        fields,
        calculate: calculations,
        lifecycle,
        actions: Object.create(null) as UdlInstrument["actions"],
        actionOrder: [],
      };
      for (const row of decl.body.entries.filter((e) =>
        e.key.startsWith("action "),
      )) {
        const name = row.key.slice(7);
        const selected = (block: BlockExpr): BlockExpr => ({
          ...block,
          entries: block.entries.flatMap((entry) => {
            if (!entry.key.startsWith("when ")) return [entry];
            const [, tunable, relation, choice] = entry.key.split(" ");
            const binding = environment.get(tunable!);
            if (!binding)
              fail(
                entry,
                `unknown branch tunable ${tunable}`,
                "name an enum or reference tunable declared by this header",
              );
            let matches: boolean;
            if (relation === "has") {
              // Inspect declarations, not lowering order: a bound object may
              // appear after the instrument that asks about its fields.
              const bound = resolve(binding!);
              const [root, ...children] = text(bound).split(".");
              const assignment = assignments.get(root!);
              let target = assignment
                ? templates.get(assignment.target)?.body
                : program.decls
                    .filter(
                      (decl): decl is InstrumentDecl =>
                        decl.kind === "instrument",
                    )
                    .find((decl) => decl.name === root)?.body;
              for (const child of children) {
                const record = target
                  ? entries(asBlock(entries(target).get("records"))).get(child)
                  : undefined;
                target = record ? asBlock(record) : undefined;
              }
              if (!target)
                fail(
                  entry,
                  "field branch needs a declared object",
                  "bind a reference to a declared object",
                );
              matches = entries(asBlock(entries(target!).get("fields"))).has(
                choice!,
              );
            } else {
              if (!enums.get(tunable!)?.includes(choice!))
                fail(
                  entry,
                  `unknown enum branch ${choice}`,
                  "use a declared enum value",
                );
              matches = text(binding!) === choice;
            }
            const body = asBlock(entry.value);
            for (const clause of body.entries)
              if (
                !["requires", "moves", "invoke", "calculate"].includes(
                  clause.key,
                ) &&
                !clause.key.startsWith("when ")
              )
                fail(
                  clause,
                  "when permits requirements, calculations, moves and invocations",
                  "keep lifecycle and actor clauses outside the branch",
                );
            return matches ? selected(body).entries : [];
          }),
        });
        const slots = entries(selected(asBlock(row.value)));
        let actionSubject: UdlActionSubject | undefined;
        let subjectExpr = slots.get("subject");
        const boundaryBindings = new Set<string>();
        const authoredMoves = slots.get("moves");
        for (const move of authoredMoves?.kind === "list"
          ? authoredMoves.items
          : authoredMoves
            ? [authoredMoves]
            : []) {
          const parts = entries(asBlock(move));
          const boundary = parts.get("boundary");
          if (!boundary) continue;
          if (
            (parts.has("operation")
              ? String(data(parts.get("operation")!))
              : "internal_transfer.create") !== "internal_transfer.reserve" ||
            parts.has("shares") ||
            parts.has("fee")
          )
            fail(
              move,
              "boundary dispatch requires a reservation",
              "reserve the exact amount before dispatch",
            );
          const adapterExpr = entries(asBlock(boundary)).get("adapter");
          if (!adapterExpr)
            fail(
              boundary,
              "boundary needs an adapter",
              "name a bound ADL adapter",
            );
          const binding = text(resolve(adapterExpr!));
          const target = adapterTarget(binding);
          if (!target)
            fail(
              boundary,
              `unknown boundary adapter ${binding}`,
              "bind the named ADL adapter before compilation",
            );
          boundaryBindings.add(binding);
        }
        if (boundaryBindings.size) {
          const block = asBlock(subjectExpr);
          const declared = new Set(
            block.entries
              .filter((entry) => entry.key === "adapter")
              .flatMap((entry) =>
                entry.value.kind === "list"
                  ? entry.value.items.map(text)
                  : [text(entry.value)],
              ),
          );
          subjectExpr = {
            ...block,
            entries: [
              ...block.entries,
              ...[...boundaryBindings]
                .filter((binding) => !declared.has(binding))
                .map((binding) => ({
                  key: "adapter",
                  value: {
                    kind: "name" as const,
                    value: binding,
                    span: row.span,
                  },
                  span: row.span,
                })),
            ],
          };
        }
        if (subjectExpr) {
          const subjectBlock = asBlock(subjectExpr);
          const directRequirements: UdlSubjectRequirement[] = [];
          const adapterList: UdlActionSubject["adapters"] = [];
          for (const entry of subjectBlock.entries) {
            if (entry.key === "adapter") {
              // A tunable names the adapter; anything else is the binding itself.
              const adapterName = (item: Expr): string =>
                item.kind === "name" &&
                decl.parameters.some(
                  (parameter) => parameter.key === item.value,
                )
                  ? text(resolve(item))
                  : text(item);
              const bindingNames =
                entry.value.kind === "list"
                  ? entry.value.items.map(adapterName)
                  : [adapterName(entry.value)];
              for (const bindingName of bindingNames) {
                const target = adapterTarget(bindingName);
                if (target) {
                  const { adapter, operation } = target;
                  const opBinding = adapter.operationMap[operation];
                  if (
                    opBinding &&
                    opBinding.subjectRequirements !== undefined
                  ) {
                    const validatedRequirements: UdlObjectField[] = [];
                    for (const req of opBinding.subjectRequirements) {
                      const result = udlObjectFieldSchema.safeParse(req);
                      if (!result.success || result.data.optional) {
                        fail(
                          entry,
                          `adapter requirement ${req.name} is invalid or optional: ${result.success ? "requirements cannot be optional" : result.error.message}`,
                          "ensure adapter subject requirements conform to UDL schema",
                        );
                      }
                      validatedRequirements.push(result.data);
                    }
                    const declaration = {
                      provider: adapter.provider,
                      capability: adapter.capability,
                      operation,
                      requirements: validatedRequirements,
                    };
                    const digest = sha256(
                      new TextEncoder().encode(canonicalJson(declaration)),
                    );
                    const snapshot: UdlAdapterSubjectSnapshot = {
                      ...declaration,
                      declarationDigest: Array.from(digest, (byte) =>
                        byte.toString(16).padStart(2, "0"),
                      ).join(""),
                    };
                    const adapterRenames: Record<string, string> = {};
                    if (attachmentInfo?.renames) {
                      for (const req of snapshot.requirements) {
                        if (attachmentInfo.renames.has(req.name)) {
                          adapterRenames[req.name] = attachmentInfo.renames.get(
                            req.name,
                          )!;
                        }
                      }
                    }
                    adapterList.push({
                      binding: bindingName,
                      snapshot,
                      ...(Object.keys(adapterRenames).length > 0
                        ? { renames: adapterRenames }
                        : {}),
                    });
                    for (const reqField of snapshot.requirements) {
                      const objectField = attachmentInfo?.renames.get(
                        reqField.name,
                      );
                      const targetName = objectField ?? reqField.name;
                      const existing = directRequirements.find(
                        (r) => (r.objectField ?? r.field.name) === targetName,
                      );
                      if (existing) {
                        if (!sameObjectField(existing.field, reqField)) {
                          failWithCode(
                            entry,
                            "subject_field_conflict",
                            `conflicting requirement ${reqField.name} in action ${name}`,
                            "rename or unify the requirement",
                          );
                        }
                      } else {
                        directRequirements.push({
                          field: { ...reqField },
                          ...(objectField ? { objectField } : {}),
                        });
                      }
                    }
                  } else {
                    adapterList.push({
                      binding: bindingName,
                      snapshot: null,
                    });
                  }
                } else {
                  adapterList.push({
                    binding: bindingName,
                    snapshot: null,
                  });
                }
              }
            } else {
              const fieldDef = lowerObjectField(entry, resolve);
              if (fieldDef.optional) {
                fail(
                  entry,
                  `subject requirement ${entry.key} cannot be optional`,
                  "remove ? from requirement",
                );
              }
              const objectField = attachmentInfo?.renames.get(entry.key);
              const targetName = objectField ?? entry.key;
              const existing = directRequirements.find(
                (r) => (r.objectField ?? r.field.name) === targetName,
              );
              if (existing) {
                if (!sameObjectField(existing.field, fieldDef)) {
                  failWithCode(
                    entry,
                    "subject_field_conflict",
                    `conflicting requirement ${entry.key} in action ${name}`,
                    "rename or unify the requirement",
                  );
                }
              } else {
                directRequirements.push({
                  field: fieldDef,
                  ...(objectField ? { objectField } : {}),
                });
              }
            }
          }
          if (directRequirements.length > 0 || adapterList.length > 0) {
            actionSubject = {
              requirements: directRequirements,
              adapters: adapterList,
            };
          }
        }
        const fromBinding = slots.get("from");
        if (
          fromBinding?.kind === "name" &&
          fromBinding.value.includes(".") &&
          slots.has("moves")
        ) {
          const [parameter, member] = fromBinding.value.split(".");
          const suppliedPolicy = supplied.get(parameter!);
          if (suppliedPolicy?.kind === "block") {
            const selected = entries(suppliedPolicy).get(member!);
            const parameterDecl = decl.parameters.find(
              (entry) => entry.key === parameter,
            );
            const fallback =
              parameterDecl?.value.kind === "default"
                ? parameterDecl.value.value
                : undefined;
            const defaultState =
              fallback?.kind === "block"
                ? entries(fallback).get(member!)
                : undefined;
            if (selected && defaultState?.kind === "name") {
              const bindings = refundBindings.get(id) ?? [];
              bindings.push({
                parameter: member!,
                span: selected.span,
                defaultState: defaultState.value,
                action: name,
              });
              refundBindings.set(id, bindings);
            }
          }
        }
        const a: UdlAction = {
          summary: slots.has("summary")
            ? String(data(slots.get("summary")!))
            : title(name),
          publicAction: camel(`${name}_${id}`),
          event: `${id}.${name}`,
          actor: "caller",
          input: lowerFields(asBlock(slots.get("input"))),
          requires: [],
          moves: [],
          ...(actionSubject ? { subject: actionSubject } : {}),
        };
        authored.set(a, row.value);
        for (const binding of boundaryBindings)
          if (
            !a.subject?.adapters.find((entry) => entry.binding === binding)
              ?.snapshot
          )
            fail(
              row,
              `boundary adapter ${binding} has no declared requirements`,
              "declare the adapter subject requirements, including an explicit empty list",
            );
        currentAction = a;
        currentActionName = name;
        if (name !== "create") {
          const from = slots.get("from");
          const to = slots.get("to");
          if (!from || !to)
            fail(
              row,
              `action ${name} needs from and to`,
              "declare its source and destination states",
            );
          const sources = from!.kind === "list" ? from!.items : [from!];
          const fromStates = sources.map((e) => String(data(e)));
          const toState = String(data(to!));
          sources.forEach((e, index) => checkState(e, fromStates[index]));
          if (toState !== "preserve") checkState(to!, toState);
          lifecycle.transitions[name] = { from: fromStates, to: toState };
        }
        for (const [key, expr] of slots) {
          if (["from", "to", "input", "summary", "subject"].includes(key))
            continue;
          if (key === "moves") {
            const moves = expr.kind === "list" ? expr.items : [expr];
            for (const [index, move] of moves.entries()) {
              const lowered = a.moves.length;
              const parts = entries(asBlock(move));
              const op = parts.has("operation")
                ? String(data(parts.get("operation")!))
                : "internal_transfer.create";
              if (op === "internal_transfer.reserve" && !parts.has("capture"))
                fail(
                  move,
                  "reserve needs a receipt field",
                  "add capture: receipt_name",
                );
              if (
                (op === "internal_transfer.post" ||
                  op === "internal_transfer.void") &&
                !parts.has("transfer")
              )
                fail(
                  move,
                  "post and void need a receipt",
                  "add transfer: receipt_name",
                );
              const key = parts.has("key")
                ? String(data(parts.get("key")!))
                : `move${index + 1}`;
              const lowerEconomics = (
                economicsExpr: Expr | undefined,
              ): UdlAction["moves"][number]["economics"] => {
                if (economicsExpr) {
                  const resolved = resolve(economicsExpr);
                  if (
                    resolved.kind === "name" &&
                    resolved.value === "unclassified"
                  )
                    return undefined;
                  const choices = entries(asBlock(resolve(economicsExpr)));
                  if (choices.has("recipient")) {
                    for (const term of choices.keys())
                      if (
                        !["recipient", "company", "participant"].includes(term)
                      )
                        fail(
                          economicsExpr,
                          `unknown economics choice ${term}`,
                          "use recipient, company and participant",
                        );
                    const recipient = String(data(choices.get("recipient")!));
                    if (
                      !isParty(recipient) ||
                      !choices.has("company") ||
                      !choices.has("participant")
                    )
                      fail(
                        economicsExpr,
                        "economics choice needs a bound recipient and both branches",
                        "declare recipient, company and participant",
                      );
                    const company =
                      recipient === "operator" ||
                      recipient === "programOperator" ||
                      document.parties[recipient]?.role === "program_operator";
                    return lowerEconomics(
                      choices.get(company ? "company" : "participant"),
                    );
                  }
                }
                const economicsParts = economicsExpr
                  ? entries(asBlock(resolve(economicsExpr)))
                  : undefined;
                if (economicsParts) {
                  for (const term of economicsParts.keys())
                    if (
                      !["purpose", "sourceParty", "reversalOf"].includes(term)
                    )
                      fail(
                        economicsExpr!,
                        `unknown economics term ${term}`,
                        "use purpose, sourceParty or reversalOf",
                      );
                }
                const purpose = economicsParts?.get("purpose");
                const sourceParty = economicsParts?.get("sourceParty");
                if (economicsParts && (!purpose || !sourceParty))
                  fail(
                    economicsExpr!,
                    "economics needs purpose and sourceParty",
                    "declare both economics fields",
                  );
                const purposeName = purpose ? String(data(purpose)) : undefined;
                if (
                  purposeName &&
                  ![
                    "earning",
                    "principal",
                    "participant_payout",
                    "internal",
                    "prepaid_credit",
                    "pass_through",
                  ].includes(purposeName)
                )
                  fail(
                    purpose!,
                    `unknown economic purpose ${purposeName}`,
                    "choose a declared economic purpose",
                  );
                const sourcePartyName = sourceParty
                  ? String(data(sourceParty))
                  : undefined;
                if (sourcePartyName && !isParty(sourcePartyName))
                  fail(
                    sourceParty!,
                    `unknown source party ${sourcePartyName}`,
                    "bind an authored party",
                  );
                return economicsParts
                  ? {
                      purpose: purposeName as NonNullable<
                        UdlAction["moves"][number]["economics"]
                      >["purpose"],
                      sourceParty: sourcePartyName!,
                      ...(economicsParts.has("reversalOf")
                        ? {
                            reversalOf: path(economicsParts.get("reversalOf")!),
                          }
                        : {}),
                    }
                  : undefined;
              };
              const economicsExpr = parts.get("economics");
              const feeEconomics =
                parts.has("fee") && economicsExpr
                  ? entries(asBlock(resolve(economicsExpr)))
                  : undefined;
              if (feeEconomics)
                for (const term of feeEconomics.keys())
                  if (!["payee", "fee", "tax"].includes(term))
                    fail(
                      economicsExpr!,
                      `unknown fee economics leg ${term}`,
                      "declare payee, fee or tax economics separately",
                    );
              const economics = lowerEconomics(
                feeEconomics ? feeEconomics.get("payee") : economicsExpr,
              );
              if (
                op === "internal_transfer.create" ||
                op === "internal_transfer.reserve"
              ) {
                const amount = parts.get("amount"),
                  from = parts.get("from"),
                  to = parts.get("to");
                if (amount) {
                  const resolvedAmount = resolve(amount);
                  if (
                    resolvedAmount.kind === "name" &&
                    resolvedAmount.value.startsWith("subject.")
                  ) {
                    const subField = resolvedAmount.value.split(".")[1]!;
                    const req = a.subject?.requirements.find(
                      (r) => r.field.name === subField,
                    );
                    if (req && req.field.type !== "money") {
                      fail(
                        amount,
                        `move amount subject.${subField} must have type money`,
                        "use a money field",
                      );
                    }
                  }
                }
                if (parts.has("shares")) {
                  if (
                    !amount ||
                    !from ||
                    op !== "internal_transfer.create" ||
                    parts.has("fee")
                  )
                    fail(
                      move,
                      "split needs a posted amount and source",
                      "declare amount, from and shares without a fee",
                    );
                  const shares = [
                    ...entries(asBlock(resolve(parts.get("shares")!))),
                  ];
                  if (!shares.length || shares.length > 64)
                    fail(
                      move,
                      "split needs 1 to 64 recipients",
                      "name the receiving parties and percentages",
                    );
                  let total = 0;
                  const pieces: UdlValue[] = [];
                  for (const [index, [party, rate]] of shares.entries()) {
                    const recipient = resolve({
                      kind: "name",
                      value: party,
                      span: rate.span,
                    });
                    if (
                      recipient.kind !== "name" ||
                      !isParty(recipient.value) ||
                      rate.kind !== "percent"
                    )
                      fail(
                        rate,
                        "split needs party percentages",
                        "write party_name: 70%",
                      );
                    total += Number(literal(rate));
                    const target = `${name}_${key}_share${index + 1}`;
                    if (fields.some((f) => f.name === target))
                      fail(
                        move,
                        "split field name conflicts",
                        "rename the move key",
                      );
                    fields.push({ name: target, type: "money" });
                    calculations.push(
                      index === shares.length - 1 && pieces.length
                        ? {
                            target,
                            op: "subtract",
                            base: val(amount),
                            subtract: [...pieces],
                          }
                        : {
                            target,
                            op: "rate",
                            base: val(amount),
                            bps: { literal: literal(rate) },
                            rounding: "floor",
                          },
                    );
                    const piece: UdlValue = { field: `self.${target}` };
                    pieces.push(piece);
                    a.moves.push({
                      key: `${key}_${index + 1}`,
                      operation: "internal_transfer.create",
                      ...(economics ? { economics } : {}),
                      amount: piece,
                      from: path(from),
                      to: `party.${recipient.value}`,
                    });
                  }
                  if (total !== 10000)
                    fail(
                      move,
                      "split percentages must sum to 100%",
                      "give the recipients exactly 100% together",
                    );
                  for (const item of a.moves.slice(lowered))
                    authored.set(item, move);
                  continue;
                }
                if (!amount || !from || !to)
                  fail(
                    move,
                    "move needs amount, from and to",
                    "declare all three move operands",
                  );
                const transfer = {
                  key,
                  operation: op,
                  ...(economics ? { economics } : {}),
                  ...(parts.has("capture")
                    ? { capture: String(data(parts.get("capture")!)) }
                    : {}),
                  amount: val(amount!),
                  from: path(from!),
                  to: path(to!),
                };
                const fee = parts.get("fee");
                if (!fee)
                  a.moves.push(
                    op === "internal_transfer.reserve"
                      ? {
                          ...transfer,
                          operation: op,
                          capture: String(data(parts.get("capture")!)),
                          ...(parts.has("boundary")
                            ? {
                                boundary: {
                                  adapter: text(
                                    resolve(
                                      entries(
                                        asBlock(parts.get("boundary")),
                                      ).get("adapter")!,
                                    ),
                                  ),
                                },
                              }
                            : {}),
                        }
                      : { ...transfer, operation: op },
                  );
                else {
                  if (op !== "internal_transfer.create")
                    fail(
                      move,
                      "fees settle with a posted transfer",
                      "declare a separate posted settlement after releasing the reservation",
                    );
                  const terms = entries(asBlock(resolve(fee)));
                  for (const term of terms.keys())
                    if (!["seller", "buyer", "tax"].includes(term))
                      fail(
                        fee,
                        `unknown fee term ${term}`,
                        "choose seller or buyer, and optional tax",
                      );
                  const paidBy = terms.has("seller") ? "seller" : "buyer";
                  if (terms.has("seller") === terms.has("buyer"))
                    fail(
                      fee,
                      "fee needs exactly one paying party",
                      "write seller: 1% or buyer: 1%",
                    );
                  const quoted = terms.get(paidBy)!;
                  const rate = quoted.kind === "capped" ? quoted.rate : quoted;
                  if (rate.kind !== "percent")
                    fail(
                      rate,
                      "fee rate needs a percentage",
                      "write a percentage such as 1%",
                    );
                  const prefix = `${name}_${key}`;
                  const derived = (
                    suffix: string,
                    calculation: Omit<UdlCalculation, "target">,
                  ): UdlValue => {
                    const target = prefix + "_" + suffix;
                    if (fields.some((f) => f.name === target))
                      fail(
                        move,
                        `generated fee field ${target} conflicts with a field`,
                        "rename the authored field or move key",
                      );
                    fields.push({ name: target, type: "money" });
                    calculations.push({
                      ...calculation,
                      target,
                    } as UdlCalculation);
                    return { field: `self.${target}` };
                  };
                  const gross = derived("feeGross", {
                    op: "rate",
                    base: transfer.amount,
                    bps: { literal: literal(rate) },
                    rounding: "floor",
                  } as Omit<UdlCalculation, "target">);
                  let charge = gross;
                  if (quoted.kind === "capped") {
                    if (quoted.cap.kind !== "money")
                      fail(
                        quoted.cap,
                        "fee cap needs money",
                        "write an amount such as 750 SAR",
                      );
                    charge = derived("fee", {
                      op: "minimum",
                      values: [gross, { literal: literal(quoted.cap) }],
                    } as Omit<UdlCalculation, "target">);
                  }
                  const tax = terms.get("tax");
                  if (tax && tax.kind !== "percent")
                    fail(
                      tax,
                      "tax needs a percentage of the fee",
                      "write tax: 15%",
                    );
                  const vat = tax
                    ? derived("tax", {
                        op: "rate",
                        base: charge,
                        bps: { literal: literal(tax) },
                        rounding: "floor",
                      } as Omit<UdlCalculation, "target">)
                    : undefined;
                  const charges = vat ? [charge, vat] : [charge];
                  const net =
                    paidBy === "seller"
                      ? derived("net", {
                          op: "subtract",
                          base: transfer.amount,
                          subtract: charges,
                        } as Omit<UdlCalculation, "target">)
                      : transfer.amount;
                  for (const [party, role] of [
                    ["programOperator", "program_operator"],
                    ["programTax", "tax_payable"],
                  ] as const) {
                    if (
                      document.parties[party] &&
                      document.parties[party]!.role !== role
                    )
                      fail(
                        move,
                        `${party} is reserved for fees`,
                        "rename this party",
                      );
                    document.parties[party] = { kind: "business", role };
                  }
                  a.moves.push({
                    ...transfer,
                    operation: "internal_transfer.create",
                    amount: net,
                  });
                  a.moves.push({
                    key: key + "Fee",
                    ...(feeEconomics?.has("fee")
                      ? { economics: lowerEconomics(feeEconomics.get("fee")) }
                      : {}),
                    operation: "internal_transfer.create",
                    amount: charge,
                    from: transfer.from,
                    to: "party.programOperator",
                  });
                  if (vat)
                    a.moves.push({
                      key: key + "Tax",
                      ...(feeEconomics?.has("tax")
                        ? { economics: lowerEconomics(feeEconomics.get("tax")) }
                        : {}),
                      operation: "internal_transfer.create",
                      amount: vat,
                      from: transfer.from,
                      to: "party.programTax",
                    });
                }
              } else if (
                op === "internal_transfer.post" ||
                op === "internal_transfer.void"
              )
                a.moves.push({
                  key,
                  operation: op,
                  ...(economics ? { economics } : {}),
                  transfer: path(parts.get("transfer")!),
                  ...(parts.has("capture")
                    ? { capture: String(data(parts.get("capture")!)) }
                    : {}),
                });
              else
                fail(
                  move,
                  `unknown transfer instruction ${op}`,
                  "choose create, reserve, post, or void from internal_transfer",
                );
              for (const item of a.moves.slice(lowered))
                authored.set(item, move);
            }
          } else (a as unknown as Record<string, unknown>)[key] = data(expr);
        }
        if (attachmentInfo && !attachmentInfo.child) {
          if (attachmentInfo.exposed.has(name)) {
            if (automatic(a.actor))
              fail(
                row,
                `${name} runs on the clock or its parent, not a caller`,
                "expose only caller actions",
              );
            a.publicAction = attachmentInfo.exposed.get(name)!;
          } else {
            delete a.publicAction;
          }
        }
        if (automatic(a.actor)) delete a.publicAction;
        const checkSubjectPaths = (obj: unknown, key = "") => {
          if (typeof obj === "string") {
            if (
              [
                "field",
                "fields",
                "reference",
                "anchor",
                "subject",
                "at",
                "instruction",
              ].includes(key) &&
              obj.startsWith("subject.")
            ) {
              const subField = obj.split(".")[1]!;
              const req = a.subject?.requirements.find(
                (r) => r.field.name === subField,
              );
              if (!req) {
                failWithCode(
                  row,
                  "subject_field_unknown",
                  `subject.${subField} names no declared subject requirement in action ${name}`,
                  `declare ${subField} in subject { ... }`,
                );
              }
            }
          } else if (Array.isArray(obj)) {
            for (const item of obj) checkSubjectPaths(item, key);
          } else if (obj !== null && typeof obj === "object") {
            for (const [key, val] of Object.entries(obj))
              checkSubjectPaths(val, key);
          }
        };
        checkSubjectPaths(a.requires);
        checkSubjectPaths(a.set);
        checkSubjectPaths(a.invoke);
        currentAction = undefined;
        currentActionName = undefined;
        for (const requirement of a.subject?.requirements ?? []) {
          const entry =
            asBlock(subjectExpr).entries.find(
              (entry) => entry.key === requirement.field.name,
            ) ??
            asBlock(subjectExpr).entries.find(
              (entry) => entry.key === "adapter",
            );
          requirementOrigins.set(requirement, {
            source: declarationSources.get(decl) ?? "program",
            span: entry?.span ?? row.span,
            message: `${id}.${name}.subject.${requirement.field.name}`,
          });
        }
        inst.actions[name] = a;
        inst.actionOrder.push(name);
      }
      if (attachmentInfo && !attachmentInfo.child)
        applyAttachmentEconomics(
          document,
          inst,
          attachmentInfo.parties,
          attachmentInfo.economics,
          data,
        );
      for (const key of [
        "invariants",
        "reports",
        "revisioned",
        "scope",
      ] as const)
        if (body.has(key))
          (inst as unknown as Record<string, unknown>)[key] = data(
            body.get(key)!,
          );
      let usesTax = false;
      for (const action of Object.values(inst.actions)) {
        for (const move of action.moves) {
          if (!("from" in move)) continue;
          for (const endpoint of ["from", "to"] as const) {
            if (move[endpoint] === "party.programTax") {
              move[endpoint] = "self.programTaxPayable";
              usesTax = true;
            }
          }
        }
      }
      if (usesTax) {
        if (inst.fields.some((field) => field.name === "programTaxPayable"))
          fail(
            decl,
            "programTaxPayable is reserved for the tax account",
            "rename the authored field",
          );
        inst.fields.push({
          name: "programTaxPayable",
          type: "account",
          owner: "programOperator",
          book: "cash",
          key: "programTax",
        });
      }
      const shape = udlInstrumentSchema.safeParse(inst);
      if (!shape.success) {
        const issue = shape.error.issues[0]!;
        const actionName =
          issue.path[0] === "actions" ? String(issue.path[1]) : undefined;
        const node =
          decl.body.entries.find(
            (entry) =>
              entry.key ===
              (actionName ? `action ${actionName}` : String(issue.path[0])),
          ) ?? decl;
        failWithCode(
          {
            span: node.span,
            source: declarationSources.get(decl) ?? "program",
          },
          "UDL1003",
          `${id}.${issue.path.join(".")}: ${issue.message}`,
          "use the UDL typed clause shape",
        );
      }
      origins.push({
        path: `$.instruments[${document.instruments.length}]`,
        span: { ...origin, ...lineColAt(source, origin.start) },
        ...(standardOrigin ? { standardBlock: standardOrigin } : {}),
      });
      if (familyDeclaration && familyDeclaration.revision !== undefined) {
        inst.family = {
          module: familyDeclaration.module,
          exportPath: familyDeclaration.exportPath,
          revision: familyDeclaration.revision,
        };
      }
      document.instruments.push(inst);
      declarations.set(inst, decl);
      for (const [key, definition] of records) {
        const childAttachment = attachmentInfo
          ? {
              ...attachmentInfo,
              attachmentName: `${attachmentInfo.attachmentName}_${key}`,
              child: true,
              exposed: new Map<string, string>(),
            }
          : undefined;
        if (childAttachment)
          childAttachment.attachments.push({
            name: childAttachment.attachmentName,
            parent: attachmentInfo!.attachmentName,
            instrument: `${id}_${key}`,
            parties: childAttachment.parties,
          });
        const child: InstrumentDecl = {
          kind: "instrument",
          name: key,
          parameters: [],
          body: asBlock(definition),
          span: origin,
        };
        declarationSources.set(
          child,
          declarationSources.get(decl) ?? "program",
        );
        const childFamily = familyDeclaration
          ? {
              module: familyDeclaration.module,
              exportPath: `${familyDeclaration.exportPath}.${key}`,
              ...(familyDeclaration.revision !== undefined
                ? { revision: familyDeclaration.revision }
                : {}),
            }
          : undefined;
        addInstrument(
          child,
          `${id}_${key}`,
          emptyBlock,
          origin,
          new Map([
            ...environment,
            ["parent", { kind: "name", value: id, span: origin } as Expr],
          ]),
          enums,
          childAttachment,
          childFamily,
          standardOrigin
            ? {
                ...standardOrigin,
                recordPath: [standardOrigin.recordPath, key]
                  .filter(Boolean)
                  .join("."),
              }
            : undefined,
        );
      }
    };
    const compileObject = (decl: ObjectDecl) => {
      const body = entries(decl.body);
      for (const key of body.keys()) {
        if (
          key !== "fields" &&
          key !== "columns" &&
          key !== "entryActions" &&
          !key.startsWith("attach ")
        ) {
          fail(
            decl,
            `unknown object clause ${key}`,
            "use fields, columns, entryActions, or attach",
          );
        }
      }

      const authoredFields: UdlObjectField[] = [];
      const authoredNames: string[] = [];
      const fieldsBlock = asBlock(body.get("fields"));
      for (const row of fieldsBlock.entries) {
        if (RESERVED_OBJECT_NAMES.some((name) => name === row.key)) {
          fail(
            row,
            `${row.key} is a reserved object name`,
            "rename this field",
          );
        }
        const fieldDef = lowerObjectField(row);
        authoredFields.push(fieldDef);
        authoredNames.push(row.key);
      }

      const attachments: UdlObjectAttachment[] = [];
      for (const entry of decl.body.entries) {
        if (!entry.key.startsWith("attach ")) continue;
        const match = /^attach\s+([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(entry.key);
        if (!match) {
          fail(
            entry,
            "invalid attach syntax",
            "write attach name = template { ... }",
          );
        }
        const attachmentName = match[1]!;
        const targetTemplate = match[2]!;
        const template = templates.get(targetTemplate);
        if (!template) {
          fail(
            entry,
            `unknown instrument ${targetTemplate}`,
            `add use ${targetTemplate.split(".")[0]} and choose a declared instrument`,
          );
        }
        const instId = `${decl.name}_${attachmentName}`;

        const attachmentBlock = asBlock(entry.value);
        const renames = new Map<string, string>();
        const renameEntries = new Map<string, Entry>();
        const exposed = new Map<string, string>();
        const economics: Entry[] = [];
        const tunableEntries: Entry[] = [];

        for (const row of attachmentBlock.entries) {
          if (row.key.startsWith("economics ")) {
            economics.push(row);
          } else if (row.key === "rename") {
            for (const r of asBlock(row.value).entries) {
              if (renames.has(r.key))
                fail(
                  r,
                  `duplicate rename ${r.key}`,
                  "rename each subject field once",
                );
              renames.set(r.key, text(r.value));
              renameEntries.set(r.key, r);
            }
          } else if (row.key === "expose") {
            if (row.value.kind === "call") {
              const actionName = row.value.name;
              const publicName = text(row.value.args[0]!);
              if (
                exposed.has(actionName) ||
                !template.body.entries.some(
                  (entry) => entry.key === `action ${actionName}`,
                )
              )
                fail(
                  row,
                  `unknown or repeated action ${actionName}`,
                  "expose one declared action once",
                );
              exposed.set(actionName, publicName);
              exposures.push({
                instrument: instId,
                action: actionName,
                entry: row,
              });
            }
          } else {
            tunableEntries.push(row);
          }
        }

        const parties: Record<string, AttachmentPartyBinding> = {};
        attachments.push({ name: attachmentName, instrument: instId, parties });

        const tunableBlock: BlockExpr = {
          kind: "block",
          entries: tunableEntries,
          span: entry.value.span,
        };

        const templateFamily = resolveFamily(targetTemplate, entry, false);
        const firstAttachedInstrument = document.instruments.length;
        try {
          addInstrument(
            template,
            instId,
            tunableBlock,
            entry.span,
            new Map(),
            new Map(),
            {
              subjectKindId: decl.name,
              attachmentName,
              renames,
              exposed,
              parties,
              attachments,
              economics,
            },
            templateFamily ? { ...templateFamily } : undefined,
            standardOrigins.get(template),
          );
        } catch (error) {
          if (!(error instanceof CompileFailure)) throw error;
          bindingDiagnostics.push(error.diagnostic);
          continue;
        }
        const attachedInst = document.instruments.find((i) => i.id === instId);
        for (const createdInst of document.instruments
          .slice(firstAttachedInstrument)
          .filter(
            (instrument) =>
              instrument.id === instId ||
              instrument.actions.create?.publicAction,
          )) {
          if (!createdInst.actions.create) continue;
          const owned = new Set(
            createdInst.calculate.map((node) => node.target),
          );
          for (const action of Object.values(createdInst.actions)) {
            for (const node of action.calculate ?? []) owned.add(node.target);
            for (const move of action.moves)
              if ("capture" in move && move.capture) owned.add(move.capture);
          }
          const create = createdInst.actions.create;
          for (const field of createdInst.fields) {
            if (
              field.type === "account" ||
              (field.type === "ref" && field.targetKind === "instrument") ||
              (field.type === "list" &&
                field.item === "ref" &&
                field.targetKind === "instrument") ||
              field.optional ||
              "value" in field ||
              owned.has(field.name) ||
              create.input.some((input) => input.name === field.name)
            )
              continue;
            create.subject ??= { requirements: [], adapters: [] };
            const existing = create.subject.requirements.find(
              (item) => item.field.name === field.name,
            );
            if (existing) {
              if (canonicalJson(existing.field) !== canonicalJson(field))
                failWithCode(
                  entry,
                  "subject_field_conflict",
                  `${createdInst.id}.create.subject.${field.name} conflicts with its instrument field`,
                  "use the instrument field's type and constraints",
                );
              continue;
            }
            const objectField = renames.get(field.name);
            const requirement = {
              field,
              ...(objectField ? { objectField } : {}),
            };
            create.subject.requirements.push(requirement);
            requirementOrigins.set(requirement, {
              source: declarationSources.get(template) ?? "program",
              span: entry.span,
              message: `${createdInst.id}.create.fields.${field.name}`,
            });
          }
        }
        for (const [oldName] of renames) {
          const found =
            attachedInst &&
            Object.values(attachedInst.actions).some((action) =>
              action.subject?.requirements.some(
                (requirement) => requirement.field.name === oldName,
              ),
            );
          if (!found) {
            const renameEntry = renameEntries.get(oldName) ?? entry;
            const declared = attachedInst
              ? Object.values(attachedInst.actions).flatMap(
                  (action) =>
                    action.subject?.requirements.map(
                      (requirement) => requirement.field.name,
                    ) ?? [],
                )
              : [];
            failWithCode(
              renameEntry,
              "subject_field_unknown",
              `rename source '${oldName}' is not a declared subject requirement of ${targetTemplate}`,
              declared.length
                ? `rename one of: ${[...new Set(declared)].join(", ")}`
                : "rename a declared subject requirement",
            );
          }
        }
      }

      const columnsExpr = body.get("columns");
      let columns: string[] = [];
      if (columnsExpr) {
        if (columnsExpr.kind !== "list") {
          fail(
            columnsExpr,
            "columns needs a list of field names",
            "write columns: [name, ...]",
          );
        }
        columns = columnsExpr.items.map(text);
        if (columns.length > 8) {
          fail(
            columnsExpr,
            `The object list selects ${columns.length} columns; this release supports 8. The object may retain all its fields.`,
            `Remove ${columns.length === 9 ? "one name" : `${columns.length - 8} names`} from \`columns\`, not from \`fields\`.`,
          );
        }
      }

      const entryExpr = body.get("entryActions");
      let entryActions: string[] | undefined;
      if (entryExpr) {
        if (entryExpr.kind !== "list" || !entryExpr.items.length)
          fail(
            entryExpr,
            "entryActions needs a nonempty list",
            "name exposed create actions bound to actor",
          );
        entryActions = entryExpr.items.map(text);
      }
      document.objects.push({
        id: decl.name,
        title: decl.title,
        ...(entryActions ? { entryActions } : {}),
        authoredFields: authoredNames,
        attachments,
        fields: authoredFields,
        columns,
      });
    };
    for (const decl of program.decls) {
      if (decl.kind === "instrument") {
        addInstrument(decl, decl.name, emptyBlock, decl.span);
      }
      if (decl.kind === "assignment") {
        const template = templates.get(decl.target);
        if (!template)
          fail(
            decl,
            `unknown instrument ${decl.target}`,
            `add use ${decl.target.split(".")[0]} and choose a declared instrument`,
          );
        const templateFamily = resolveFamily(decl.target, decl, false);
        addInstrument(
          template,
          decl.name,
          decl.body,
          decl.span,
          new Map(),
          new Map(),
          undefined,
          templateFamily ? { ...templateFamily } : undefined,
          standardOrigins.get(template),
        );
      }
      if (decl.kind === "object") {
        compileObject(decl);
      }
    }
    if (bindingDiagnostics.length)
      return {
        verdict: "invalid",
        diagnostics: distinct(bindingDiagnostics)
          .sort((a, b) => a.span.start - b.span.start)
          .map((d) => diagnostic(d, "check")),
      };
    // Resolve selectors after every attachment and child has its family.
    const retainSelectionFamilies = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      const selection = record.selection as
        | { instrument: string | string[]; family?: UdlFamily }
        | undefined;
      if (selection && !selection.family) {
        const families = [selection.instrument]
          .flat()
          .map(
            (id) => document.instruments.find((item) => item.id === id)?.family,
          );
        const family = families[0];
        if (
          family &&
          families.every(
            (item) => canonicalJson(item) === canonicalJson(family),
          )
        )
          selection.family = family;
      }
      for (const child of Object.values(record)) retainSelectionFamilies(child);
    };
    retainSelectionFamilies(document);
    // Propagate invoked requirements with the conditions on each invocation path.
    let changedInvocations = true;
    let invocationIterations = 0;
    const invocationDepth = document.instruments.reduce(
      (total, inst) => total + inst.actionOrder.length,
      0,
    );
    while (changedInvocations && invocationIterations < invocationDepth) {
      changedInvocations = false;
      invocationIterations++;
      for (const inst of document.instruments) {
        for (const [actionName, action] of Object.entries(inst.actions)) {
          for (const call of action.invoke ?? []) {
            let targetIds: string[] = [];
            if ("instrument" in call) {
              targetIds = [call.instrument];
            } else if ("selection" in call) {
              targetIds = Array.isArray(call.selection.instrument)
                ? call.selection.instrument
                : [call.selection.instrument];
            } else if ("reference" in call) {
              const refField = resolveField(
                document,
                inst,
                call.reference,
                action.input,
                action,
              );
              if (
                refField?.type === "ref" &&
                refField.targetKind === "instrument"
              ) {
                targetIds = Array.isArray(refField.target)
                  ? refField.target
                  : [refField.target];
              }
            }
            for (const targetId of targetIds) {
              const targetInst = document.instruments.find(
                (i) => i.id === targetId,
              );
              if (!targetInst) continue;
              if (
                inst.subject &&
                targetInst.subject &&
                inst.subject === targetInst.subject
              ) {
                const targetAction = targetInst.actions[call.action];
                if (!targetAction?.subject) continue;
                if (!action.subject) {
                  action.subject = { requirements: [], adapters: [] };
                }
                for (const adapter of call.guard
                  ? []
                  : targetAction.subject.adapters) {
                  if (
                    !action.subject.adapters.some(
                      (existing) => existing.binding === adapter.binding,
                    )
                  ) {
                    action.subject.adapters.push(adapter);
                    changedInvocations = true;
                  }
                }
                for (const targetReq of targetAction.subject.requirements) {
                  const targetObjFieldName =
                    targetReq.objectField ?? targetReq.field.name;
                  const existing = action.subject.requirements.find(
                    (cr) =>
                      (cr.objectField ?? cr.field.name) === targetObjFieldName,
                  );
                  const guardValue = (value: UdlValue): UdlValue => {
                    if (
                      !("field" in value) ||
                      !value.field.startsWith("subject.")
                    )
                      return value;
                    const requirement = action.subject?.requirements.find(
                      (item) => item.field.name === value.field.slice(8),
                    );
                    return {
                      field: `subject.${requirement?.objectField ?? requirement?.field.name ?? value.field.slice(8)}`,
                    };
                  };
                  const guardType =
                    call.guard &&
                    [call.guard.left, call.guard.right]
                      .flatMap((value) =>
                        "field" in value
                          ? [
                              resolveField(
                                document,
                                inst,
                                value.field,
                                action.input,
                                action,
                              )?.type,
                            ]
                          : [],
                      )
                      .find((type) => type === "money" || type === "date");
                  const condition:
                    | NonNullable<UdlSubjectRequirement["when"]>[number][number]
                    | undefined = call.guard
                    ? {
                        instrument: inst.id,
                        action: actionName,
                        guard: {
                          ...call.guard,
                          left: guardValue(call.guard.left),
                          right: guardValue(call.guard.right),
                        },
                        ...(guardType === "money" || guardType === "date"
                          ? { valueType: guardType }
                          : {}),
                      }
                    : undefined;
                  const when = condition
                    ? (targetReq.when ?? [[]]).map((path) => [
                        condition,
                        ...path.filter(
                          (item) =>
                            canonicalJson(item) !== canonicalJson(condition),
                        ),
                      ])
                    : targetReq.when;
                  if (!existing) {
                    const inherited: UdlSubjectRequirement = {
                      field: { ...targetReq.field, name: targetObjFieldName },
                      ...(when ? { when: when.map((path) => [...path]) } : {}),
                    };
                    action.subject.requirements.push(inherited);
                    requirementOrigins.set(
                      inherited,
                      requirementOrigins.get(targetReq)!,
                    );
                    changedInvocations = true;
                  } else if (
                    !sameObjectField(existing.field, targetReq.field)
                  ) {
                    const first = requirementOrigins.get(existing)!;
                    const second = requirementOrigins.get(targetReq)!;
                    throw new CompileFailure({
                      code: "subject_field_conflict",
                      message: `${first.message} conflicts with ${second.message}: incompatible requirement '${targetObjFieldName}'`,
                      fix: "ensure compatible requirement definitions across invoked actions",
                      span: first.span,
                      source: first.source,
                      related: [first, second],
                    });
                  } else if (existing.when) {
                    if (!when) {
                      delete existing.when;
                      changedInvocations = true;
                    } else {
                      for (const path of when) {
                        if (
                          !existing.when.some(
                            (known) =>
                              canonicalJson(known) === canonicalJson(path),
                          )
                        ) {
                          existing.when.push(path);
                          changedInvocations = true;
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    for (const kind of document.objects) {
      const origins = new Map(
        kind.fields.map((field) => [
          field.name,
          `authored field ${kind.id}.${field.name}`,
        ]),
      );
      for (const instrument of document.instruments.filter(
        (item) => item.subject === kind.id,
      )) {
        for (const name of instrument.actionOrder) {
          for (const requirement of instrument.actions[name]!.subject
            ?.requirements ?? []) {
            const field = {
              ...requirement.field,
              name: requirement.objectField ?? requirement.field.name,
            };
            const previous = kind.fields.find(
              (item) => item.name === field.name,
            );
            const origin = `${instrument.id}.${name}.subject.${requirement.field.name}`;
            if (previous && !sameObjectField(previous, field)) {
              failWithCode(
                objects.get(kind.id)!,
                "subject_field_conflict",
                `${origin} conflicts with ${origins.get(field.name)}: incompatible types or constraints`,
                "rename fields with different meanings",
              );
            }
            if (!previous) {
              kind.fields.push(field);
              origins.set(field.name, origin);
            }
          }
        }
      }
      for (const column of kind.columns) {
        if (!kind.fields.some((field) => field.name === column))
          failWithCode(
            objects.get(kind.id)!,
            "subject_field_unknown",
            `column ${column} is unknown on ${kind.id}`,
            "name an authored field or attached requirement",
          );
      }
    }
    // Names resolve here, once tunables, attachments and derived fields are
    // final, and each failure points at the expression that wrote the name.
    type Located = { span: Span; source?: string };
    type Scope = { inst: UdlInstrument; label: string; action?: UdlAction };
    const byId = new Map(document.instruments.map((inst) => [inst.id, inst]));
    const site = (owner: object, key: string | number, fallback: Located) => {
      const expr = authored.get(owner);
      if (expr?.kind === "block")
        return expr.entries.find((entry) => entry.key === key)?.value ?? expr;
      if (expr?.kind === "list" && Array.isArray(owner))
        return expr.items.length === owner.length
          ? expr.items[Number(key)]!
          : expr;
      return expr ?? fallback;
    };
    const keySite = (owner: object, key: string, fallback: Located) => {
      const expr = authored.get(owner);
      const entry =
        expr?.kind === "block"
          ? expr.entries.find((item) => item.key === key)
          : undefined;
      if (!entry) return fallback;
      return {
        ...entry,
        span: { start: entry.span.start, end: entry.span.start + key.length },
      };
    };
    const builtins = (inst: UdlInstrument) => [
      "id",
      "now",
      "createdAt",
      "productRevision",
      "status",
      ...(inst.subject ? ["subject"] : []),
    ];
    const parties = (inst: UdlInstrument) => [
      ...Object.keys(document.parties),
      ...(inst.subject ? subjectPartyRoles : []),
    ];
    const members = (field: UdlField): string[] => {
      if (field.type === "account") return ["balance", "reserved"];
      if (field.type !== "ref") return [];
      const [id] = [field.target].flat();
      const target =
        field.targetKind === "object"
          ? document.objects.find((object) => object.id === id)
          : byId.get(id!);
      if (!target) return [];
      return [
        ...target.fields.map((item) => item.name),
        ...("lifecycle" in target ? builtins(target) : []),
      ];
    };
    const checkParty = (name: string, at: Located, inst: UdlInstrument) => {
      const names = parties(inst);
      if (!names.includes(name))
        fail(
          at,
          `\`${name}\` is not a declared party.${didYouMean(name, names)}`,
          `Declare it with \`party ${name}: business\`, or name a declared party (${names.join(", ")}).`,
        );
    };
    const checkInput = (
      name: string,
      at: Located,
      label: string,
      input: readonly UdlField[],
    ) => {
      const names = input.map((field) => field.name);
      if (!names.includes(name))
        fail(
          at,
          `\`${name}\` is not an input of \`${label}\`.${didYouMean(name, names)}`,
          `Declare \`${name}\` in the input of \`${label}\`${names.length ? `, or use one of ${names.join(", ")}` : ""}.`,
        );
    };
    const checkTarget = (id: string, at: Located, objects = false) => {
      const ids = [
        ...byId.keys(),
        ...(objects ? document.objects.map((object) => object.id) : []),
      ];
      const noun = objects ? "instrument or object" : "instrument";
      if (!ids.includes(id))
        fail(
          at,
          `\`${id}\` is not a declared ${noun}.${didYouMean(id, ids)}`,
          `Name a declared ${noun}.`,
        );
    };
    const checkPath = (path: string, at: Located, scope: Scope): void => {
      const { inst, action } = scope;
      const parts = path.split(".");
      const found = (count: number) =>
        resolveField(
          document,
          inst,
          parts.slice(0, count).join("."),
          action?.input,
          action,
        );
      // Subject paths keep their own check against the action's requirements.
      if (found(parts.length) || parts[0] === "subject") return;
      if (parts[0] === "party" && parts[1]) {
        checkParty(parts[1], at, inst);
        if (!found(2)) return;
      }
      if (!["self", "input", "party"].includes(parts[0]!))
        parts.unshift("self");
      let count = 2;
      while (count <= parts.length && found(count)) count++;
      if (count > parts.length) return;
      const name = parts[count - 1]!;
      if (count > 2) {
        const prefix = parts.slice(0, count - 1).join(".");
        const names = members(found(count - 1)!);
        fail(
          at,
          `\`${name}\` is not a field of \`${prefix}\`.${didYouMean(name, names)}`,
          names.length
            ? `Use one of ${names.join(", ")}.`
            : `\`${prefix}\` has no fields.`,
        );
      }
      if (parts[0] === "input")
        return checkInput(name, at, scope.label, action?.input ?? []);
      const declared = declarations.get(inst)!.name;
      const fields = inst.fields.map((field) => field.name);
      fail(
        at,
        `\`${name}\` is not a field or party of \`${declared}\`.${didYouMean(name, [...fields, ...builtins(inst), ...parties(inst)])}`,
        `Use a field declared in \`${declared}\` (${fields.join(", ")}) or a declared party (${parties(inst).join(", ")}).`,
      );
    };
    const scopeOf = (inst: UdlInstrument): Scope => ({
      inst,
      label: declarations.get(inst)!.name,
    });
    const checkSelection = (
      selection: UdlSelection,
      at: Located,
      scope: Scope,
    ) => {
      walk(selection.anchor, "anchor", site(selection, "anchor", at), scope);
      walk(selection.where, "where", site(selection, "where", at), scope);
      for (const id of [selection.instrument].flat()) {
        checkTarget(id, site(selection, "instrument", at));
        const target = scopeOf(byId.get(id)!);
        const member = (key: string, where: Located) =>
          checkPath(
            key.startsWith("self.") ? key : `self.${key}`,
            where,
            target,
          );
        for (const key of Object.keys(selection.where ?? {}))
          member(key, keySite(selection.where!, key, at));
        member(selection.reference, site(selection, "reference", at));
        selection.order?.forEach((key, index) =>
          member(key, site(selection.order!, index, at)),
        );
        if (selection.window)
          member(selection.window.field, site(selection.window, "field", at));
      }
    };
    const checkCall = (
      call: NonNullable<UdlAction["invoke"]>[number],
      at: Located,
      scope: Scope,
    ) => {
      const bind = "range" in call ? call.range?.bind : undefined;
      for (const [key, value] of Object.entries(call))
        if (key !== "input") walk(value, key, site(call, key, at), scope);
      for (const [key, value] of Object.entries(call.input))
        if (!("field" in value) || value.field !== bind)
          walk(value, key, site(call.input, key, at), scope);
      if ("instrument" in call)
        checkTarget(call.instrument, site(call, "instrument", at));
      const reference =
        "reference" in call
          ? resolveField(
              document,
              scope.inst,
              call.reference,
              scope.action?.input,
              scope.action,
            )
          : undefined;
      const ids =
        "instrument" in call
          ? [call.instrument]
          : "selection" in call
            ? [call.selection.instrument].flat()
            : reference?.type === "ref" && reference.targetKind === "instrument"
              ? [reference.target].flat()
              : [];
      for (const id of ids) {
        const target = byId.get(id);
        if (!target) continue;
        const action = target.actions[call.action];
        if (!action)
          fail(
            site(call, "action", at),
            `\`${call.action}\` is not an action of \`${id}\`.${didYouMean(call.action, target.actionOrder)}`,
            `Use one of ${target.actionOrder.join(", ")}.`,
          );
        for (const key of Object.keys(call.input))
          checkInput(
            key,
            keySite(call.input, key, at),
            `${id}.${call.action}`,
            action.input,
          );
      }
    };
    const pathKeys = [
      "field",
      "reference",
      "anchor",
      "at",
      "list",
      "from",
      "to",
      "transfer",
      "subject",
      "instruction",
      "installment",
      "recipient",
      "dueAt",
      "fields",
    ];
    const walk = (
      value: unknown,
      key: string,
      at: Located,
      scope: Scope,
    ): void => {
      if (typeof value === "string") {
        if (key === "party") checkParty(value, at, scope.inst);
        if (key === "target") checkPath(`self.${value}`, at, scope);
        if (pathKeys.includes(key)) checkPath(value, at, scope);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value))
        return value.forEach((item, index) =>
          walk(item, key, site(value, index, at), scope),
        );
      if (key === "selection")
        return checkSelection(value as UdlSelection, at, scope);
      if (key === "invoke")
        return checkCall(
          value as NonNullable<UdlAction["invoke"]>[number],
          at,
          scope,
        );
      if (key === "set")
        for (const name of Object.keys(value))
          checkPath(`self.${name}`, keySite(value, name, at), scope);
      for (const [child, item] of Object.entries(value))
        walk(item, child, site(value, child, at), scope);
    };
    for (const inst of document.instruments) {
      const decl = declarations.get(inst)!;
      const scope = scopeOf(inst);
      for (const field of [
        ...inst.fields,
        ...Object.values(inst.actions).flatMap((action) => action.input),
      ])
        if ("target" in field && field.target !== undefined)
          for (const id of [field.target].flat())
            checkTarget(id, site(field, "target", decl), true);
      walk(inst.calculate, "calculate", decl, scope);
      walk(inst.invariants, "invariants", decl, scope);
      for (const [name, action] of Object.entries(inst.actions))
        for (const [key, value] of Object.entries(action))
          if (key !== "input" && key !== "subject")
            walk(value, key, site(action, key, decl), {
              inst,
              label: `${decl.name}.${name}`,
              action,
            });
    }
    const eliminatedStates = new Map<string, Set<string>>();
    // Remove branches excluded by immutable tunables before checking reference states.
    for (const inst of document.instruments) {
      if (
        !inst.lifecycle.states.includes(inst.lifecycle.initial) ||
        Object.values(inst.lifecycle.transitions).some(
          (edge) =>
            edge.from.some((state) => !inst.lifecycle.states.includes(state)) ||
            (edge.to !== "preserve" &&
              !inst.lifecycle.states.includes(edge.to)),
        )
      )
        continue;
      let specialized = false;
      for (const [key, action] of Object.entries(inst.actions)) {
        const constant = (value: import("@hyperscale0/udl").UdlValue) => {
          if ("literal" in value) return value.literal;
          const f = inst.fields.find((f) => `self.${f.name}` === value.field);
          return f && "value" in f ? f.value : undefined;
        };
        if (
          action.requires.some((r) => {
            if (r.kind !== "compare") return false;
            const left = constant(r.left),
              right = constant(r.right);
            if (left === undefined || right === undefined) return false;
            return r.operator === "=="
              ? left !== right
              : r.operator === "!="
                ? left === right
                : false;
          })
        ) {
          delete inst.actions[key];
          delete inst.lifecycle.transitions[key];
          specialized = true;
        }
      }
      if (!specialized) continue;
      const reachable = new Set([inst.lifecycle.initial]);
      for (let n = 0; n < inst.lifecycle.states.length; n++)
        for (const edge of Object.values(inst.lifecycle.transitions))
          if (edge.from.some((state) => reachable.has(state)))
            if (edge.to !== "preserve") reachable.add(edge.to);
      for (const [key, edge] of Object.entries(inst.lifecycle.transitions)) {
        edge.from = edge.from.filter((state) => reachable.has(state));
        if (!edge.from.length) {
          delete inst.actions[key];
          delete inst.lifecycle.transitions[key];
        }
      }
      eliminatedStates.set(
        inst.id,
        new Set(inst.lifecycle.states.filter((state) => !reachable.has(state))),
      );
      inst.lifecycle.states = inst.lifecycle.states.filter((state) =>
        reachable.has(state),
      );
      inst.actionOrder = inst.actionOrder.filter((key) => inst.actions[key]);
    }
    for (const inst of document.instruments)
      for (const action of Object.values(inst.actions)) {
        for (const requirement of action.requires) {
          if (requirement.kind !== "state") continue;
          const field = inst.fields.find(
            (f) => `self.${f.name}` === requirement.reference,
          );
          if (field?.type === "ref")
            requirement.states = requirement.states.filter(
              (state) =>
                !(
                  typeof field.target === "string"
                    ? [field.target]
                    : field.target
                ).some((id) => eliminatedStates.get(id)?.has(state)),
            );
        }
      }
    for (const exposure of exposures)
      if (
        !document.instruments.find((inst) => inst.id === exposure.instrument)
          ?.actions[exposure.action]
      )
        fail(
          exposure.entry,
          `action ${exposure.action} is excluded by these bindings`,
          "expose an action available with these tunables",
        );
    const changed = new Set<string>();
    for (const decl of program.decls)
      if (decl.kind === "hide" || decl.kind === "expose") {
        const parts = decl.target.split(".");
        const key = parts.pop();
        const id = parts.join("_");
        const action = document.instruments.find((i) => i.id === id)?.actions[
          key ?? ""
        ];
        if (!action || changed.has(decl.target))
          fail(
            decl,
            `unknown or repeated action ${decl.target}`,
            "name one declared object.action once",
          );
        changed.add(decl.target);
        if (decl.kind === "hide") delete action!.publicAction;
        else if (automatic(action!.actor))
          fail(
            decl,
            `${decl.target} runs on the clock or its parent, not a caller`,
            "expose only caller actions",
          );
        else action!.publicAction = decl.name!;
      }
    for (const decl of program.decls) {
      if (decl.kind !== "expose") continue;
      const parts = decl.target.split(".");
      parts.pop();
      const instrument = document.instruments.find(
        (item) => item.id === parts.join("_"),
      )!;
      if (
        Object.values(instrument.actions).filter(
          (action) => action.publicAction === decl.name,
        ).length > 1
      )
        fail(
          decl,
          `public action ${decl.name} is used more than once on ${parts.join(".")}`,
          "give each exposed action a distinct public name",
        );
    }
    for (const kind of document.objects) {
      for (const name of kind.entryActions ?? []) {
        const eligible = kind.attachments.some((attachment) => {
          const create = document.instruments.find(
            (instrument) => instrument.id === attachment.instrument,
          )?.actions.create;
          return (
            create?.publicAction === name &&
            typeof create.actor === "object" &&
            "party" in create.actor &&
            create.actor.party === "actor"
          );
        });
        if (!eligible)
          fail(
            objects.get(kind.id)!,
            `entry action ${name} must create an attachment as actor`,
            "expose its create action and bind its acting party to actor",
          );
      }
    }
    const validated = validateUdl(document);
    if (!validated.ok)
      return {
        verdict: "invalid",
        diagnostics: validated.issues.map((i) => {
          const origin = [...origins]
            .reverse()
            .find((o) => i.path.startsWith(o.path));
          const index = /^\$\.instruments\[(\d+)\]/.exec(i.path)?.[1];
          const instrument =
            index === undefined
              ? undefined
              : document.instruments[Number(index)];
          const attachment = document.objects
            .flatMap((object) => object.attachments)
            .find((attachment) => attachment.instrument === instrument?.id);
          const stranded = i.stranded;
          if (instrument && stranded?.accounts.length) {
            const binding = refundBindings
              .get(instrument.id)
              ?.find(
                (binding) =>
                  binding.defaultState === stranded.state &&
                  instrument.actions[binding.action]?.moves.some(
                    (move) =>
                      "amount" in move &&
                      stranded.accounts.some(
                        (account) => move.from === `self.${account}`,
                      ),
                  ),
              );
            return diagnostic(
              {
                code: i.code,
                message: `\`${attachment?.name ?? instrument.id}\` can reach \`${stranded.state}\` with money in ${stranded.accounts.map((account) => `\`${account}\``).join(", ")}, but no action leaves that state and disposes of the balance.`,
                fix: binding
                  ? `Restore \`${binding.parameter}: ${stranded.state}\`, or author a complete refund path for every reachable funded state.`
                  : "Author a complete refund path for every reachable funded state.",
                span: binding?.span ?? origin?.span ?? program.span,
                related: stranded.accounts.map((account) => ({
                  source: "program",
                  span: origin?.span ?? program.span,
                  message: `State path: ${instrument.lifecycle.initial} -> ${(stranded.paths[account] ?? stranded.actions).join(" -> ")} -> ${stranded.state}; owned accounts: ${account}.`,
                })),
              },
              "lower",
            );
          }
          return diagnostic(
            {
              code: i.code,
              message: `${i.path}: ${i.message}`,
              fix: i.fix,
              span: origin?.span ?? program.span,
            },
            "lower",
          );
        }),
      };
    return {
      verdict: "valid",
      diagnostics: [],
      artifacts: {
        document: validated.value,
        costManifest: buildUdlCostManifest(validated.value),
        originMap: origins,
      },
    };
  } catch (error) {
    if (error instanceof CompileFailure)
      return {
        verdict: "invalid",
        diagnostics: distinct([...bindingDiagnostics, error.diagnostic]).map(
          (d) => diagnostic(d, "check"),
        ),
      };
    throw error;
  }
}
