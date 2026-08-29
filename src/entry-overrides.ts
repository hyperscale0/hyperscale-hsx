/**
 * Data-driven replacement of existing settlement entries. This is not syntax:
 * callers select a slot that already exists in the parsed program, replace its
 * literal value, then run the ordinary checker and lowerer again.
 */

import type { BlockExpr, Entry, Expr, Program, SettlementDecl } from "./ast.ts";

export type ProgramEntryOverrideValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "basis_points"; readonly value: number };

export interface ProgramEntryOverrideBounds {
  readonly max: number;
  readonly min: number;
}

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

function replacementExpr(
  current: Expr,
  value: ProgramEntryOverrideValue,
): Expr {
  if (value.kind === "integer") {
    return { kind: "number", raw: String(value.value), span: current.span };
  }
  return {
    bps: value.value,
    kind: "percent",
    raw: percentRaw(value.value),
    span: current.span,
  };
}

function replaceEntry(
  block: BlockExpr,
  path: readonly string[],
  value: ProgramEntryOverrideValue,
): { readonly block?: BlockExpr; readonly issue?: string } {
  const [head, ...tail] = path;
  const matches = block.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.key.name === head);
  if (matches.length === 0) return { issue: `entry ${head} does not exist` };
  if (matches.length > 1) return { issue: `entry ${head} is ambiguous` };

  const match = matches[0] as { readonly entry: Entry; readonly index: number };
  let nextEntry: Entry;
  if (tail.length === 0) {
    if (
      match.entry.value.kind !== "number" &&
      match.entry.value.kind !== "percent"
    ) {
      return { issue: `entry ${head} is not a numeric literal` };
    }
    nextEntry = {
      ...match.entry,
      value: replacementExpr(match.entry.value, value),
    };
  } else {
    if (match.entry.value.kind !== "block") {
      return { issue: `entry ${head} is not a block` };
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
): SettlementDecl | undefined {
  return program.decls.find(
    (decl): decl is SettlementDecl =>
      decl.kind === "settlement" && decl.name.name === name,
  );
}

function validateOverride(
  override: ProgramEntryOverride,
): ProgramEntryOverrideIssue | undefined {
  const { max, min } = override.bounds;
  if (
    !Number.isFinite(min) ||
    !Number.isInteger(min) ||
    min < 0 ||
    !Number.isFinite(max) ||
    !Number.isInteger(max) ||
    max < min
  ) {
    return {
      code: "invalid_bounds",
      message: `override bounds ${min}..${max} must be finite nonnegative integers with min at most max`,
      path: override.path,
      settlement: override.settlement,
    };
  }

  const { value } = override.value;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return {
      code: "invalid_value",
      message: `override value ${value} must be a finite nonnegative integer`,
      path: override.path,
      settlement: override.settlement,
    };
  }
  if (value < min || value > max) {
    return {
      code: "invalid_value",
      message: `override value ${value} is outside ${min}..${max}`,
      path: override.path,
      settlement: override.settlement,
    };
  }
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
      settlement.body,
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
        decl === settlement ? { ...settlement, body: replaced.block! } : decl,
      ),
    };
  }
  return issues.length > 0
    ? { issues, ok: false }
    : { ok: true, program: current };
}
