/**
 * Data-driven replacement of existing settlement entries. This is not syntax:
 * callers select a slot that already exists in the parsed program, replace its
 * literal value, then run the ordinary general compiler again.
 */

import type {
  BlockExpr,
  Entry,
  Expr,
  InstrumentApplyDecl,
  Program,
} from "./ast.ts";

export type ProgramEntryOverrideValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "basis_points"; readonly value: number }
  | {
      readonly currency: string;
      readonly kind: "money";
      readonly value: number;
    }
  | { readonly kind: "duration"; readonly value: string };

export type ProgramEntryOverrideBounds =
  | { readonly max: number; readonly min: number }
  | {
      readonly currency: string;
      readonly max: number;
      readonly min: number;
    }
  | { readonly max: string; readonly min: string };

export interface ProgramEntryOverride {
  readonly bounds: ProgramEntryOverrideBounds;
  readonly settlement: string;
  /** Entry keys below the settlement body, for example `["fees", "merchant"]`. */
  readonly path: readonly [string, ...string[]];
  readonly value: ProgramEntryOverrideValue;
}

export interface ProgramEntryOverrideIssue {
  readonly code:
    | "invalid_bounds"
    | "invalid_target"
    | "invalid_value"
    | "missing_settlement";
  readonly message: string;
  readonly settlement: string;
  readonly path: readonly string[];
}

type OverrideResult =
  | {
      readonly ok: true;
      readonly program: Program;
    }
  | {
      readonly issues: readonly ProgramEntryOverrideIssue[];
      readonly ok: false;
    };

function percentRaw(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  return fraction === 0
    ? `${whole}`
    : `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

function durationMagnitude(
  value: string,
): { readonly amount: number; readonly family: "days" | "months" } | undefined {
  const match = /^P([1-9][0-9]{0,3})([DWMY])$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  switch (match[2]) {
    case "D":
      return { amount, family: "days" };
    case "W":
      return { amount: amount * 7, family: "days" };
    case "M":
      return { amount, family: "months" };
    case "Y":
      return { amount: amount * 12, family: "months" };
    default:
      return undefined;
  }
}

function replacementExpr(
  current: Expr,
  value: ProgramEntryOverrideValue,
): { readonly expr?: Expr; readonly issue?: string } {
  if (value.kind === "integer") {
    return current.kind === "number"
      ? {
          expr: {
            kind: "number",
            raw: String(value.value),
            span: current.span,
          },
        }
      : { issue: "target is not an integer literal" };
  }
  if (value.kind === "basis_points") {
    return current.kind === "percent"
      ? {
          expr: {
            bps: value.value,
            kind: "percent",
            raw: percentRaw(value.value),
            span: current.span,
          },
        }
      : { issue: "target is not a percentage literal" };
  }
  if (value.kind === "duration") {
    return current.kind === "ident" && durationMagnitude(current.name)
      ? {
          expr: { kind: "ident", name: value.value, span: current.span },
        }
      : { issue: "target is not an ISO-8601 duration literal" };
  }
  if (
    current.kind !== "binding" ||
    current.type.kind !== "call" ||
    current.type.callee.name !== "money" ||
    current.type.args.length !== 2 ||
    current.type.args[0]?.kind !== "ident" ||
    current.type.args[1]?.kind !== "number"
  ) {
    return { issue: "target is not a fixed money literal" };
  }
  if (current.type.args[0].name !== value.currency) {
    return {
      issue: `target currency ${current.type.args[0].name} does not match ${value.currency}`,
    };
  }
  return {
    expr: {
      ...current,
      type: {
        ...current.type,
        args: [
          current.type.args[0],
          {
            kind: "number",
            raw: String(value.value),
            span: current.type.args[1].span,
          },
        ],
      },
    },
  };
}

function selectedEntry(
  block: BlockExpr,
  path: readonly string[],
):
  | {
      readonly match: { readonly entry: Entry; readonly index: number };
      readonly tail: readonly string[];
    }
  | { readonly issue: string } {
  const [head, ...tail] = path;
  const matches = block.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.key.name === head);
  if (matches.length === 0) return { issue: `entry ${head} does not exist` };
  if (matches.length === 1) return { match: matches[0]!, tail };
  const occurrence = Number(tail[0]);
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    return { issue: `entry ${head} is ambiguous` };
  }
  const match = matches[occurrence];
  return match
    ? { match, tail: tail.slice(1) }
    : { issue: `entry ${head} occurrence ${occurrence} does not exist` };
}

function replaceEntry(
  block: BlockExpr,
  path: readonly string[],
  value: ProgramEntryOverrideValue,
): { readonly block?: BlockExpr; readonly issue?: string } {
  const selected = selectedEntry(block, path);
  if (!("match" in selected)) return selected;
  const { match, tail } = selected;
  let nextEntry: Entry;
  if (tail.length === 0) {
    const replacement = replacementExpr(match.entry.value, value);
    if (!replacement.expr) return replacement;
    nextEntry = {
      ...match.entry,
      value: replacement.expr,
    };
  } else if (
    tail.length === 1 &&
    tail[0] === "within" &&
    match.entry.value.kind === "port_ref" &&
    match.entry.value.within
  ) {
    const replacement = replacementExpr(match.entry.value.within, value);
    if (!replacement.expr || replacement.expr.kind !== "ident") {
      return replacement;
    }
    nextEntry = {
      ...match.entry,
      value: { ...match.entry.value, within: replacement.expr },
    };
  } else {
    if (match.entry.value.kind !== "block") {
      return { issue: `entry ${match.entry.key.name} is not a block` };
    }
    const nested = replaceEntry(match.entry.value, tail, value);
    if (!nested.block) return nested;
    nextEntry = { ...match.entry, value: nested.block };
  }

  return {
    block: {
      ...block,
      entries: block.entries.map((entry, index) =>
        index === match.index ? nextEntry : entry,
      ),
    },
  };
}

function settlementByName(
  program: Program,
  name: string,
): InstrumentApplyDecl | undefined {
  return program.decls.find(
    (decl): decl is InstrumentApplyDecl =>
      decl.kind === "instrument_apply" && decl.name.name === name,
  );
}

function applicationBody(settlement: InstrumentApplyDecl): BlockExpr {
  return {
    entries: settlement.application.args.flatMap((argument) =>
      argument.kind === "binding"
        ? [
            {
              key: argument.name,
              qualifiers: [],
              span: argument.span,
              value: argument.type,
            },
          ]
        : [],
    ),
    kind: "block",
    span: settlement.application.span,
  };
}

function validateOverride(
  override: ProgramEntryOverride,
): ProgramEntryOverrideIssue | undefined {
  const { max, min } = override.bounds;
  if (override.value.kind === "duration") {
    if (typeof min !== "string" || typeof max !== "string") {
      return issue(
        override,
        "invalid_bounds",
        "duration bounds must be ISO-8601 durations",
      );
    }
    const minDuration = durationMagnitude(min);
    const maxDuration = durationMagnitude(max);
    if (
      !minDuration ||
      !maxDuration ||
      minDuration.family !== maxDuration.family ||
      minDuration.amount > maxDuration.amount
    ) {
      return issue(
        override,
        "invalid_bounds",
        `duration bounds ${min}..${max} must be valid, comparable, and ordered`,
      );
    }
    const value = durationMagnitude(override.value.value);
    if (
      !value ||
      value.family !== minDuration.family ||
      value.amount < minDuration.amount ||
      value.amount > maxDuration.amount
    ) {
      return issue(
        override,
        "invalid_value",
        `override value ${override.value.value} is outside ${min}..${max}`,
      );
    }
    return undefined;
  }
  if (typeof min !== "number" || typeof max !== "number") {
    return issue(
      override,
      "invalid_bounds",
      "numeric bounds must be finite nonnegative integers",
    );
  }
  if (
    !Number.isFinite(min) ||
    !Number.isInteger(min) ||
    min < 0 ||
    !Number.isFinite(max) ||
    !Number.isInteger(max) ||
    max < min
  ) {
    return issue(
      override,
      "invalid_bounds",
      `override bounds ${min}..${max} must be finite nonnegative integers with min at most max`,
    );
  }

  const { value } = override.value;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return issue(
      override,
      "invalid_value",
      `override value ${value} must be a finite nonnegative integer`,
    );
  }
  if (value < min || value > max) {
    return issue(
      override,
      "invalid_value",
      `override value ${value} is outside ${min}..${max}`,
    );
  }
  if (override.value.kind === "money") {
    const boundsCurrency =
      "currency" in override.bounds ? override.bounds.currency : undefined;
    if (!boundsCurrency || boundsCurrency !== override.value.currency) {
      return issue(
        override,
        "invalid_bounds",
        `money bounds must use currency ${override.value.currency}`,
      );
    }
  }
}

function issue(
  override: ProgramEntryOverride,
  code: ProgramEntryOverrideIssue["code"],
  message: string,
): ProgramEntryOverrideIssue {
  return {
    code,
    message,
    path: override.path,
    settlement: override.settlement,
  };
}

/**
 * Applies every override atomically. A missing or non-literal slot returns
 * issues and no program, so callers never lower a partially configured shape.
 */
export function overrideProgramEntries(
  program: Program,
  overrides: readonly ProgramEntryOverride[],
): OverrideResult {
  let current = program;
  const issues: ProgramEntryOverrideIssue[] = [];
  for (const override of overrides) {
    const validationIssue = validateOverride(override);
    if (validationIssue) {
      issues.push(validationIssue);
      continue;
    }
    const settlement = settlementByName(current, override.settlement);
    if (!settlement) {
      issues.push({
        code: "missing_settlement",
        message: `settlement ${override.settlement} does not exist`,
        path: override.path,
        settlement: override.settlement,
      });
      continue;
    }
    const replaced = replaceEntry(
      applicationBody(settlement),
      override.path,
      override.value,
    );
    if (!replaced.block) {
      issues.push({
        code: "invalid_target",
        message: replaced.issue ?? "entry override failed",
        path: override.path,
        settlement: override.settlement,
      });
      continue;
    }
    current = {
      ...current,
      decls: current.decls.map((decl) =>
        decl === settlement
          ? {
              ...settlement,
              application: {
                ...settlement.application,
                args: replaced.block!.entries.map((entry) => ({
                  kind: "binding" as const,
                  name: entry.key,
                  span: entry.span,
                  type: entry.value,
                })),
              },
            }
          : decl,
      ),
    };
  }
  return issues.length > 0
    ? { issues, ok: false }
    : { ok: true, program: current };
}
