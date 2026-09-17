import { buildUdlCostManifest, type UdlCostManifest } from "./cost.ts";
import {
  validateUdl,
  type UdlAction,
  type UdlCalculation,
  type UdlDocument,
  type UdlField,
  type UdlInstrument,
  type UdlValue,
} from "@hyperscale0/udl";
import { tunableBounds } from "./tunables.ts";
import { parseProgram } from "./parse.ts";
import {
  lineColAt,
  type BlockExpr,
  type Diagnostic,
  type Expr,
  type InstrumentDecl,
  type ObjectDecl,
  type Span,
} from "./ast.ts";
import { bundledStandardLibrary, type StandardLibrary } from "./std-library.ts";

export interface CompileDiagnostic extends Diagnostic {
  line: number;
  column: number;
  severity: "error";
  stage: "parse" | "check" | "lower";
}
export interface CompileOriginMapEntry {
  path: string;
  span: Span & { line: number; column: number };
}
export interface CompileOptions {
  standardLibrary?: StandardLibrary;
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
class CompileFailure extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}
function fail(expr: { span: Span }, message: string, fix: string): never {
  throw new CompileFailure({ code: "HSX1001", message, fix, span: expr.span });
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
  actor === "clock" || (typeof actor === "object" && "parent" in actor);
const title = (name: string) =>
  name[0]!.toUpperCase() + name.slice(1).replaceAll("_", " ");
function entries(block: BlockExpr): Map<string, Expr> {
  const map = new Map<string, Expr>();
  for (const row of block.entries) {
    const previous = map.get(row.key);
    if (previous) {
      if (
        !["requires", "moves", "invariants", "invoke", "calculate"].includes(
          row.key,
        )
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
function literal(expr: Expr): string | number | boolean {
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
    (expr.kind === "name" && /^P(?:\d|T)/.test(expr.value)) ||
    (expr.kind === "text" && /^P(?:\d|T)/.test(expr.value))
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
      /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
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
    if (
      !Number.isFinite(n) ||
      new Date(raw.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) !==
        raw.slice(0, 10)
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
  const diagnostic = (
    d: Diagnostic,
    stage: CompileDiagnostic["stage"],
  ): CompileDiagnostic => ({
    ...d,
    ...lineColAt(source, d.span.start),
    severity: "error",
    stage,
  });
  if (parsed.diagnostics.length)
    return {
      verdict: "invalid",
      diagnostics: parsed.diagnostics.map((d) => diagnostic(d, "parse")),
    };
  const program = parsed.program;
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
      const header = parseProgram(content);
      if (
        header.diagnostics.length ||
        !header.program.header ||
        header.program.name !== use.name
      )
        fail(
          use,
          `header ${use.name} is malformed`,
          "repair the header source before compiling",
        );
      for (const decl of header.program.decls)
        if (decl.kind === "instrument")
          templates.set(`${use.name}.${decl.name}`, decl);
    }
    const document: UdlDocument = {
      udl: 3,
      version: 1,
      product: program.name,
      title: program.title,
      currency: "SAR",
      parties: {
        programOperator: { kind: "business", role: "program_operator" },
        programTax: { kind: "business", role: "tax_payable" },
        programFines: { kind: "business", role: "fine_payable" },
        programCosts: { kind: "business", role: "cost_recovery" },
      },
      instruments: [],
    };
    const objects = new Map<string, ObjectDecl>();
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
      if (decl.kind === "object") objects.set(decl.name, decl);
      if (decl.kind === "party") {
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
    const materialApprovals = new Set<UdlAction>();
    const implicitDecisions = new Map<
      string,
      { target: string; action: string; party: string; origin: Span }
    >();
    const addInstrument = (
      decl: InstrumentDecl,
      id: string,
      arguments_: BlockExpr,
      origin: Span,
      inherited = new Map<string, Expr>(),
      inheritedApprovers = new Set<string>(),
      inheritedEnums = new Map<string, string[]>(),
    ) => {
      const enums = new Map(inheritedEnums);
      for (const parameter of decl.parameters) {
        const type =
          parameter.value.kind === "default"
            ? parameter.value.type
            : parameter.value;
        if (type.kind === "call" && type.name === "enum")
          enums.set(parameter.key, type.args.map(text));
      }
      const approvers = new Set(inheritedApprovers);
      const supplied = entries(arguments_);
      const environment = new Map<string, Expr>(inherited);
      for (const param of decl.parameters) {
        const type =
          param.value.kind === "default" ? param.value.type : param.value;
        const fallback =
          param.value.kind === "default" ? param.value.value : undefined;
        const actual = supplied.get(param.key) ?? fallback;
        if (!actual) {
          if (type.kind === "type" && type.optional) continue;
          fail(
            { span: origin },
            `${id} needs ${param.key}`,
            `add ${param.key}: value inside ${id}`,
          );
        }
        environment.set(param.key, actual);
      }
      for (const key of supplied.keys())
        if (!decl.parameters.some((p) => p.key === key))
          fail(
            supplied.get(key)!,
            `unknown tunable ${key}`,
            `choose ${decl.parameters.map((p) => p.key).join(", ")}`,
          );
      const resolve = (expr: Expr, seen = new Set<string>()): Expr => {
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
                  .filter(([, party]) => party.kind === type)
                  .map(([name]) => name)
              : [...objects.values()]
                  .filter(
                    (object) =>
                      object.object === type ||
                      type.startsWith(`${object.object}.`),
                  )
                  .map(
                    (object) =>
                      object.name +
                      type.slice(object.object.length).replaceAll(".", "_"),
                  );
          if (expr.name !== "all" && matches.length !== 1)
            fail(
              { span: origin },
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
        if (expr.value.startsWith("party.")) {
          const binding = environment.get(expr.value.slice(6));
          if (binding?.kind === "name" && document.parties[binding.value])
            return { ...expr, value: `party.${binding.value}` };
        }
        const [root, ...tail] = expr.value.split(".");
        const bound = environment.get(root!);
        if (!bound || (bound.kind === "name" && bound.value === root))
          return expr;
        if (seen.has(root!))
          return fail(
            expr,
            `cyclic tunable ${root}`,
            "replace the cycle with a literal or declared reference",
          );
        let resolved =
          supplied.has(root!) || inherited.has(root!) || enums.has(root!)
            ? bound
            : resolve(bound, new Set([...seen, root!]));
        for (const key of tail) {
          if (resolved.kind !== "block") return expr;
          const child = entries(resolved).get(key);
          if (!child)
            return fail(
              expr,
              `missing tunable ${expr.value}`,
              `declare ${key} in ${root}`,
            );
          resolved = resolve(child, new Set([...seen, root!]));
        }
        return resolved;
      };
      for (const param of decl.parameters) {
        const actual = environment.get(param.key);
        if (!actual) continue;
        const t =
          param.value.kind === "default" ? param.value.type : param.value;
        const type = t.kind === "type" || t.kind === "call" ? t.name : text(t);
        const v =
          supplied.has(param.key) || type === "enum" ? actual : resolve(actual);
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
        } else if (type === "party" || type === "approval") {
          if (v.kind !== "name" || !document.parties[v.value])
            fail(
              v,
              `${param.key} needs a declared party`,
              "declare a party and use its name here",
            );
          if (type === "approval") approvers.add(text(v));
        } else if (type === "ref") {
          const values = v.kind === "list" ? v.items : [v];
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
            const [root, ...tail] = value.value.split(".");
            const obj = objects.get(root!);
            if (
              (!obj &&
                !document.instruments.some(
                  (inst) => inst.id === value.value,
                )) ||
              (t.kind === "type" &&
                t.target &&
                [obj?.object, ...tail].join(".") !== t.target)
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
        } else if (type === "fee" || type === "split" || type === "policy") {
          if (v.kind !== "block")
            fail(v, `${param.key} needs a block`, `write ${param.key} { ... }`);
        } else if (
          type === "money" ||
          type === "percent" ||
          type === "date" ||
          type === "duration" ||
          type === "integer" ||
          type === "text"
        ) {
          if (v.kind === "name" && v.value === "runtime") continue;
          const expected = type === "integer" ? "number" : type;
          if (
            v.kind !== expected &&
            !(
              type === "duration" &&
              (v.kind === "text" || v.kind === "name") &&
              /^P/.test(v.value)
            )
          )
            fail(v, `${param.key} needs ${type}`, `write a ${type} literal`);
          try {
            const value = literal(v);
            const bounds = tunableBounds(t);
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
        }
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
            "fields",
            "lifecycle",
            "records",
            "summary",
            "invariants",
            "constraints",
          ].includes(key) &&
          !key.startsWith("action ")
        )
          fail(
            decl,
            `unknown instrument clause ${key}`,
            "use fields, lifecycle, actions, invariants, or records",
          );
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
      const path = (expr: Expr): string => {
        const value = resolve(expr);
        const name = text(value);
        if (document.parties[name]) return `party.${name}`;
        return /^(self|input|party)\./.test(name) ? name : `self.${name}`;
      };
      const val = (expr: Expr): UdlValue => {
        const v = resolve(expr);
        return v.kind === "name" && !["true", "false"].includes(v.value)
          ? { field: path(v) }
          : { literal: literal(v) };
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
          const result = Object.fromEntries(
            [...entries(value)].map(([key, value]) => [key, data(value)]),
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
          return result;
        }
        if (value.kind === "list")
          return value.items.map(data).filter((item) => item !== null);
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
          const t = row.value.kind === "default" ? row.value.type : row.value;
          const constant =
            row.value.kind === "default" ? resolve(row.value.value) : undefined;
          const type =
            t.kind === "type" || t.kind === "call" ? t.name : text(t);
          const f: Record<string, unknown> = {
            name: row.key,
            type,
            ...(t.kind === "type" && t.optional ? { optional: true } : {}),
          };
          if (type === "enum" && t.kind === "call") f.values = t.args.map(text);
          if (["integer", "money"].includes(type) && t.kind === "call") {
            if (t.args.length !== 2)
              fail(
                t,
                "bounded fields need a minimum and maximum",
                "write integer(1, 12) or money(0 SAR, 100 SAR)",
              );
            f.minimum = literal(resolve(t.args[0]!));
            f.maximum = literal(resolve(t.args[1]!));
          }
          if (type === "list" && t.kind === "call") {
            f.item = text(t.args[0]!);
            f.maxItems = t.args[1] ? literal(resolve(t.args[1])) : 366;
          }
          if (type === "list" && t.kind === "type") {
            f.item = t.target;
            f.maxItems = 366;
          }
          if (type === "ref") {
            const target = t.kind === "type" ? t.target : undefined;
            if (!target)
              fail(row, "reference needs a target", "write ref<object>");
            const [root, ...tail] = target.split(".");
            const resolved = environment.get(root!);
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
          } else if (type === "account") {
            if (t.kind === "call") {
              if (t.args.length < 1 || t.args.length > 4)
                fail(
                  t,
                  "account needs an owner, optional book, mode and key",
                  "write account(buyer, claim, contra)",
                );
              f.owner = text(resolve(t.args[0]!));
              f.book = t.args[1] ? text(t.args[1]) : "cash";
              if (t.args[2]) {
                const mode = text(t.args[2]);
                if (["contra", "external"].includes(mode)) f[mode] = true;
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
            } else if (type === "enum" && constant.kind === "name")
              f.value = constant.value;
            else if (type === "money" && constant.kind === "name")
              calculations.push({
                target: row.key,
                op: "sum",
                values: [val(constant)],
              });
            else f.value = literal(constant);
          }
          result.push(f as UdlField);
        }
        return result;
      };
      fields.push(...lowerFields(asBlock(body.get("fields"))));
      const lifecycle = data(
        body.get("lifecycle") ?? emptyBlock,
      ) as UdlInstrument["lifecycle"];
      lifecycle.transitions = {};
      const inst: UdlInstrument = {
        id,
        title: title(id),
        summary: body.has("summary")
          ? String(data(body.get("summary")!))
          : title(id),
        fields,
        calculate: calculations,
        lifecycle,
        actions: {},
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
            const [, tunable, , choice] = entry.key.split(" ");
            const binding = environment.get(tunable!);
            if (!binding)
              fail(
                entry,
                `unknown branch tunable ${tunable}`,
                "name an enum tunable declared by this header",
              );
            if (!enums.get(tunable!)?.includes(choice!))
              fail(
                entry,
                `unknown enum branch ${choice}`,
                "use a declared enum value",
              );
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
            return text(binding) === choice ? selected(body).entries : [];
          }),
        });
        const slots = entries(selected(asBlock(row.value)));
        const a: UdlAction = {
          summary: slots.has("summary")
            ? String(data(slots.get("summary")!))
            : `${title(name)} ${id}`,
          publicAction: camel(`${name}_${id}`),
          event: `${id}.${name}`,
          actor: "caller",
          input: lowerFields(asBlock(slots.get("input"))),
          requires: [],
          moves: [],
        };
        if (name !== "create") {
          const from = slots.get("from");
          const to = slots.get("to");
          if (!from || !to)
            fail(
              row,
              `action ${name} needs from and to`,
              "declare its source and destination states",
            );
          lifecycle.transitions[name] = {
            from: (from!.kind === "list" ? from!.items : [from!]).map((e) =>
              String(data(e)),
            ),
            to: String(data(to!)),
          };
        }
        for (const [key, expr] of slots) {
          if (["from", "to", "input", "summary"].includes(key)) continue;
          if (key === "moves") {
            const moves = expr.kind === "list" ? expr.items : [expr];
            for (const [index, move] of moves.entries()) {
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
              if (
                op === "internal_transfer.create" ||
                op === "internal_transfer.reserve"
              ) {
                const amount = parts.get("amount"),
                  from = parts.get("from"),
                  to = parts.get("to");
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
                      !document.parties[recipient.value] ||
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
                    operation: "internal_transfer.create",
                    amount: charge,
                    from: transfer.from,
                    to: "party.programOperator",
                  });
                  if (vat)
                    a.moves.push({
                      key: key + "Tax",
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
            }
          } else if (key === "approval") {
            const approval = data(expr) as UdlAction["approval"];
            if (approval && (approval.input as unknown) === "material") {
              approval.input = {};
              materialApprovals.add(a);
            }
            a.approval = approval;
          } else (a as unknown as Record<string, unknown>)[key] = data(expr);
        }
        if (automatic(a.actor)) delete a.publicAction;
        for (const requirement of a.requires ?? []) {
          if (
            requirement.kind !== "approval" ||
            !approvers.has(requirement.party)
          )
            continue;
          const action = requirement.action ?? name;
          const key = `${id}_${action}_decision`;
          const previous = implicitDecisions.get(key);
          if (previous && previous.party !== requirement.party)
            fail(
              { span: origin },
              `action ${action} has multiple approval parties`,
              "use a separate decision action for each party",
            );
          implicitDecisions.set(key, {
            target: id,
            action,
            party: requirement.party,
            origin,
          });
        }
        inst.actions[name] = a;
        inst.actionOrder.push(name);
      }
      for (const key of ["invariants"] as const)
        if (body.has(key))
          (inst as unknown as Record<string, unknown>)[key] = data(
            body.get(key)!,
          );
      origins.push({
        path: `$.instruments[${document.instruments.length}]`,
        span: { ...origin, ...lineColAt(source, origin.start) },
      });
      document.instruments.push(inst);
      for (const [key, definition] of records) {
        const child: InstrumentDecl = {
          kind: "instrument",
          name: key,
          parameters: [],
          body: asBlock(definition),
          span: origin,
        };
        addInstrument(
          child,
          `${id}_${key}`,
          emptyBlock,
          origin,
          new Map([
            ...environment,
            ["parent", { kind: "name", value: id, span: origin } as Expr],
          ]),
          approvers,
          enums,
        );
      }
    };
    for (const decl of program.decls) {
      if (decl.kind === "instrument") {
        if (decl.parameters.length)
          fail(
            decl,
            "program records cannot declare tunables",
            "put reusable instruments in a header",
          );
        addInstrument(decl, decl.name, emptyBlock, decl.span);
      }
      if (decl.kind === "object") {
        const template = templates.get(decl.object);
        if (!template)
          fail(
            decl,
            `unknown object ${decl.object}`,
            `add use ${decl.object.split(".")[0]} and choose a declared object`,
          );
        addInstrument(template, decl.name, decl.body, decl.span);
      }
    }
    const eliminatedStates = new Map<string, Set<string>>();
    // Remove branches excluded by immutable tunables before checking reference states.
    for (const inst of document.instruments) {
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
        }
      }
      const reachable = new Set([inst.lifecycle.initial]);
      for (let n = 0; n < inst.lifecycle.states.length; n++)
        for (const edge of Object.values(inst.lifecycle.transitions))
          if (edge.from.some((state) => reachable.has(state)))
            reachable.add(edge.to);
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
    // Approval tunables instantiate the same library record as an explicit decision.
    if (implicitDecisions.size) {
      const content = (
        options.standardLibrary ?? bundledStandardLibrary
      ).source("approvals");
      const parsed = content ? parseProgram(content) : undefined;
      const template = parsed?.program.decls.find(
        (decl) => decl.kind === "instrument" && decl.name === "decision",
      );
      if (
        !template ||
        template.kind !== "instrument" ||
        parsed?.diagnostics.length
      )
        fail(
          program,
          "implicit decisions need the approvals header",
          "provide the standard approvals header",
        );
      for (const [id, decision] of implicitDecisions) {
        if (
          !document.instruments.find((inst) => inst.id === decision.target)
            ?.actions[decision.action]
        )
          continue;
        const existing = document.instruments.some((inst) =>
          Object.values(inst.actions).some(
            (action) =>
              action.approval?.action === decision.action &&
              action.approval.party === decision.party &&
              inst.fields.some(
                (field) =>
                  field.type === "ref" &&
                  field.target === decision.target &&
                  `self.${field.name}` === action.approval?.target,
              ),
          ),
        );
        if (existing) continue;
        if (document.instruments.some((inst) => inst.id === id))
          fail(
            { span: decision.origin },
            `implicit decision name ${id} is already used`,
            "rename the conflicting object",
          );
        addInstrument(
          template,
          id,
          {
            kind: "block",
            span: decision.origin,
            entries: Object.entries({
              for: decision.target,
              approved_by: decision.party,
              action: decision.action,
            }).map(([key, value]) => ({
              key,
              value: {
                kind: key === "action" ? "text" : "name",
                value,
                span: decision.origin,
              },
              span: decision.origin,
            })),
          },
          decision.origin,
        );
      }
    }
    // Material approval fields are inferred from the selected action's typed input.
    for (const inst of document.instruments)
      for (const action of Object.values(inst.actions)) {
        if (!materialApprovals.has(action) || !action.approval) continue;
        const targetField = inst.fields.find(
          (f) => `self.${f.name}` === action.approval!.target,
        );
        if (targetField?.type !== "ref") continue;
        const target = document.instruments.find(
          (i) => i.id === targetField.target,
        )?.actions[action.approval.action];
        if (!target) continue;
        for (const field of target.input) {
          const name = `material_${field.name}`;
          if (!inst.fields.some((f) => f.name === name))
            inst.fields.push({ ...field, name });
          action.approval.input[field.name] = { field: `self.${name}` };
        }
      }
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
    const usedParties = new Set<string>();
    const collectParties = (value: unknown): void => {
      if (typeof value === "string") {
        usedParties.add(value);
        if (value.startsWith("party.")) usedParties.add(value.split(".")[1]!);
      } else if (Array.isArray(value)) value.forEach(collectParties);
      else if (value && typeof value === "object")
        Object.values(value).forEach(collectParties);
    };
    collectParties(document.instruments);
    for (const party of ["programFines", "programCosts"])
      if (!usedParties.has(party) && !names.has(party))
        delete document.parties[party];
    const validated = validateUdl(document);
    if (!validated.ok)
      return {
        verdict: "invalid",
        diagnostics: validated.issues.map((i) => {
          const origin = [...origins]
            .reverse()
            .find((o) => i.path.startsWith(o.path));
          return diagnostic(
            {
              code: "HSX1601",
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
        diagnostics: [diagnostic(error.diagnostic, "check")],
      };
    throw error;
  }
}
