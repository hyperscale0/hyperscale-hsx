import { parseProgram } from "./parse.ts";
import { CompileFailure, conflict, fail } from "./diagnostics.ts";
import type { BlockExpr, Entry, Expr, InstrumentDecl, Span } from "./ast.ts";

/** Compilation and editor metadata admit the same named header declarations. */
export function parseHeader(source: string, name: string) {
  const parsed = parseProgram(source);
  if (parsed.diagnostics.length)
    throw new CompileFailure({ ...parsed.diagnostics[0]!, source: name });
  const program = parsed.program;
  const locate = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("span" in value) Object.assign(value, { source: name });
    for (const child of Object.values(value)) locate(child);
  };
  locate(program);
  if (!program.header || program.name !== name)
    fail(
      program,
      `${name}: expected header ${name}`,
      `start with header ${name}`,
    );
  const texts = new Map([[name, source]]);
  const names = new Map<string, InstrumentDecl>();
  for (const decl of program.decls) {
    if (decl.kind !== "instrument") continue;
    const first = names.get(decl.name);
    if (first)
      conflict(
        texts,
        `instrument ${name}.${decl.name} is declared twice`,
        first,
        decl,
        "give each instrument a distinct name",
      );
    names.set(decl.name, decl);
    const parameters = new Map<string, Entry>();
    for (const parameter of decl.parameters) {
      const earlier = parameters.get(parameter.key);
      if (earlier)
        conflict(
          texts,
          `parameter ${parameter.key} is declared twice`,
          earlier,
          parameter,
          "declare each parameter once",
        );
      parameters.set(parameter.key, parameter);
      const type =
        parameter.value.kind === "default"
          ? parameter.value.type
          : parameter.value;
      if (type.kind === "call" && !["enum", "integer"].includes(type.name))
        fail(
          type,
          `unsupported tunable constructor ${type.name}`,
          "Only enum(choices) and integer(minimum, maximum) are supported tunable constructors. This constructor's restrictions cannot be enforced.",
        );
    }
  }
  return program;
}

export interface Check {
  /** The rule as written, such as `late_from < early_until`. */
  rule: Expr;
  test:
    | { kind: "set"; tunable: string }
    | { kind: "type"; tunable: string }
    | { kind: "compare"; left: Expr[]; operator: string; right: Expr[] };
  when?: { selector: string; is: string };
  message: string;
  fix: string;
  span: Span;
  source?: string;
}
const slots = (expr: Expr | undefined) =>
  new Map(
    expr?.kind === "block"
      ? expr.entries.map((entry) => [entry.key, entry.value])
      : [],
  );
const typeOf = (parameter: Entry) =>
  parameter.value.kind === "default" ? parameter.value.type : parameter.value;

/**
 * An instrument's `checks`. A check that names an undeclared tunable or
 * choice refuses here, so no rule is dropped without a word.
 */
export function instrumentChecks(decl: InstrumentDecl): Check[] {
  const tunable = (expr: Expr | undefined): Entry => {
    const parameter =
      expr?.kind === "name"
        ? decl.parameters.find((item) => item.key === expr.value)
        : undefined;
    if (!parameter)
      fail(
        expr ?? decl,
        `a check of ${decl.name} names a tunable it does not declare`,
        `name one of ${decl.parameters.map((item) => item.key).join(", ")}`,
      );
    return parameter;
  };
  // Literal operands stand as written; a name must be a declared tunable.
  const terms = (operand: Expr | undefined): Expr[] => {
    const [slot] = operand?.kind === "block" ? operand.entries : [];
    const items =
      slot?.key === "sum" && slot.value.kind === "list"
        ? slot.value.items
        : slot?.key === "literal"
          ? [slot.value]
          : fail(
              slot?.value ?? decl,
              "a check compares tunables and literals",
              "name a tunable or write a literal",
            );
    for (const item of items) if (item.kind === "name") tunable(item);
    return items;
  };
  return decl.body.entries
    .filter((entry) => entry.key === "checks")
    .flatMap((block) =>
      block.value.kind === "block"
        ? block.value.entries
        : fail(
            block,
            "checks needs a block",
            "write checks { rule { message, fix } }",
          ),
    )
    .map((entry): Check => {
      const check = slots(entry.value);
      const rule = check.get("rule") as BlockExpr;
      const parts = slots(rule);
      const explain = slots(check.get("explain"));
      const message = explain.get("message");
      const fix = explain.get("fix");
      if (
        explain.size !== 2 ||
        message?.kind !== "text" ||
        fix?.kind !== "text"
      )
        fail(
          entry,
          "a check needs a message and a fix",
          'write { message: "...", fix: "..." } after the rule',
        );
      const kind = parts.get("kind");
      let test: Check["test"];
      if (kind?.kind === "text" && kind.value === "compare")
        test = {
          kind: "compare",
          left: terms(parts.get("left")),
          operator: (parts.get("operator") as { value: string }).value,
          right: terms(parts.get("right")),
        };
      else if (kind?.kind === "text" && kind.value === "is") {
        const parameter = tunable(parts.get("tunable"));
        const is = parts.get("is");
        const type = typeOf(parameter);
        const typeName =
          type.kind === "type" || type.kind === "call"
            ? type.name
            : type.kind === "name"
              ? type.value
              : "";
        if (
          is?.kind !== "name" ||
          (is.value !== "set" && is.value !== typeName)
        )
          fail(
            is ?? entry,
            `${parameter.key} is ${typeName}, so its check reads ${parameter.key} is set or ${parameter.key} is ${typeName}`,
            `write ${parameter.key} is set, or ${parameter.key} is ${typeName} to explain its type rule`,
          );
        test = {
          kind: is.value === "set" ? "set" : "type",
          tunable: parameter.key,
        };
      } else
        fail(
          rule,
          "a check is a comparison, x is set, or x is its type",
          "write a < b, a + b <= c, x is set or x is money",
        );
      const scope = slots(check.get("when"));
      let when: Check["when"];
      if (check.has("when")) {
        const selector = tunable(scope.get("selector"));
        const is = scope.get("is");
        const type = typeOf(selector);
        // An optional selector reads like `when every is unset`.
        const presence =
          (type.kind === "type" || type.kind === "call") &&
          type.name !== "enum" &&
          !!type.optional &&
          is?.kind === "name" &&
          ["set", "unset"].includes(is.value);
        const choice =
          type.kind === "call" &&
          type.name === "enum" &&
          type.args.some(
            (arg) =>
              arg.kind === "name" &&
              is?.kind === "name" &&
              arg.value === is.value,
          );
        if (
          (!presence && !choice) ||
          is?.kind !== "name" ||
          test.kind === "type"
        )
          fail(
            check.get("when")!,
            "when must select a declared enum choice, or set or unset of an optional tunable",
            "write when kind is <choice>, or when every is unset",
          );
        when = { selector: selector.key, is: is.value };
      }
      return {
        rule,
        test,
        ...(when ? { when } : {}),
        message: message.value,
        fix: fix.value,
        span: entry.span,
        ...("source" in entry ? { source: entry.source as string } : {}),
      };
    });
}
