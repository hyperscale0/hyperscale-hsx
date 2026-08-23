/**
 * The HSX compiler driver: source text in, three-verdict result out.
 *
 * - `valid`: the program lowers cleanly; the IR document and frame are ready
 *   for the independent checker.
 * - `warning`: the program lowers, and the compiler's lint voice has notes
 *   the author should read (the artifacts are still present and usable).
 * - `invalid`: the program cannot be lowered; diagnostics say why, in the
 *   author's language, each anchored to a source line and column.
 *
 * Every diagnostic points at SOURCE coordinates, never at lowered IR paths.
 */

import { lineColAt } from "./ast.ts";
import { checkProgram } from "./check.ts";
import { lowerProgram } from "./lower.ts";
import { parseProgram } from "./parse.ts";

type Json = Record<string, unknown>;

type CompileVerdict = "invalid" | "valid" | "warning";

interface CompileDiagnostic {
  /** 1-indexed source column. */
  readonly column: number;
  /** 1-indexed source line. */
  readonly line: number;
  readonly message: string;
  readonly severity: "error" | "warning";
  /** The stage that raised it: parse, check, or lower. */
  readonly stage: "check" | "lower" | "parse";
}

interface CompileArtifacts {
  /** The lowered HSX-JSON IR document, for the independent checker. */
  readonly document: Json;
  /** The congruent Business Frame. */
  readonly frame: Json;
}

export interface CompileResult {
  /** Present exactly when the verdict is not `invalid`. */
  readonly artifacts?: CompileArtifacts;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly verdict: CompileVerdict;
}

export function compile(source: string): CompileResult {
  const diagnostics: CompileDiagnostic[] = [];
  const at = (
    stage: CompileDiagnostic["stage"],
    severity: CompileDiagnostic["severity"],
    message: string,
    offset: number,
  ): void => {
    const position = lineColAt(source, offset);
    diagnostics.push({
      column: position.column,
      line: position.line,
      message,
      severity,
      stage,
    });
  };

  const parsed = parseProgram(source);
  for (const diagnostic of parsed.diagnostics) {
    at("parse", "error", diagnostic.message, diagnostic.span.start);
  }
  if (parsed.diagnostics.length > 0) {
    return { diagnostics, verdict: "invalid" };
  }

  const checked = checkProgram(parsed.program);
  for (const diagnostic of checked.diagnostics) {
    at("check", diagnostic.severity, diagnostic.message, diagnostic.span.start);
  }
  if (!checked.program) {
    return { diagnostics, verdict: "invalid" };
  }

  const loweredResult = lowerProgram(checked.program);
  if (!loweredResult.ok) {
    for (const issue of loweredResult.issues) {
      at("lower", "error", issue.message, issue.span.start);
    }
    return { diagnostics, verdict: "invalid" };
  }

  return {
    artifacts: {
      document: loweredResult.value.document,
      frame: loweredResult.value.frame,
    },
    diagnostics,
    verdict: diagnostics.length > 0 ? "warning" : "valid",
  };
}
