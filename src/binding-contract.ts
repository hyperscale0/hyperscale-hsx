import type { Entry, Expr, InstrumentDecl } from "./ast.ts";

export class BindingContractError extends Error {
  constructor(
    readonly entry: Entry,
    message: string,
  ) {
    super(message);
  }
}

function rows(value: Expr): Entry[] {
  if (value.kind === "block") return value.entries;
  throw new BindingContractError(
    { key: "contract", value, span: value.span },
    "Binding contract needs a block.",
  );
}
function properties(entry: Entry, allowed: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const slot of rows(entry.value)) {
    if (
      !allowed.includes(slot.key) ||
      result.has(slot.key) ||
      (slot.value.kind !== "text" && slot.value.kind !== "name")
    )
      throw new BindingContractError(
        slot,
        "Invalid binding contract property.",
      );
    result.set(slot.key, slot.value.value);
  }
  if (allowed.some((key) => !result.get(key)))
    throw new BindingContractError(
      entry,
      `Binding contract needs ${allowed.join(", ")}.`,
    );
  return result;
}
function contractEntries(decl: InstrumentDecl, name: string): Entry[] {
  const blocks = decl.body.entries.filter((entry) => entry.key === name);
  if (blocks.length > 1)
    throw new BindingContractError(blocks[1]!, `Duplicate ${name}.`);
  const entries = blocks[0] ? rows(blocks[0].value) : [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      seen.has(entry.key) ||
      !decl.parameters.some((parameter) => parameter.key === entry.key)
    )
      throw new BindingContractError(
        entry,
        "Binding contract must name each declared tunable once.",
      );
    seen.add(entry.key);
  }
  return entries;
}

/** Conditional requirements are header data, independent of module names. */
export function bindingDependencies(decl: InstrumentDecl) {
  return contractEntries(decl, "dependencies").map((entry) => {
    const values = properties(entry, ["selector", "is", "message", "fix"]);
    const selector = decl.parameters.find(
      (parameter) => parameter.key === values.get("selector"),
    );
    const type =
      selector?.value.kind === "default"
        ? selector.value.type
        : selector?.value;
    if (
      type?.kind !== "call" ||
      type.name !== "enum" ||
      !type.args.some(
        (arg) => arg.kind === "name" && arg.value === values.get("is"),
      )
    )
      throw new BindingContractError(
        entry,
        "Dependency must select a declared enum choice.",
      );
    return {
      binding: entry.key,
      when: values.get("selector")!,
      is: values.get("is")!,
      message: values.get("message")!,
      fix: values.get("fix")!,
      span: entry.span,
    };
  });
}

/** A header explains why a typed parameter cannot encode a proposed policy. */
export function parameterDiagnostics(decl: InstrumentDecl) {
  return contractEntries(decl, "parameterDiagnostics").map((entry) => {
    const values = properties(entry, ["accepts", "percentage", "fix"]);
    return {
      parameter: entry.key,
      accepts: values.get("accepts")!,
      percentage: values.get("percentage")!,
      fix: values.get("fix")!,
    };
  });
}
