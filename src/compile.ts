/**
 * The HSX compiler driver: source text in, three-verdict result out.
 *
 * - `valid`: the program lowers cleanly; the IR document is ready
 *   for the independent checker.
 * - `warning`: the program lowers, and the compiler's lint voice has notes
 *   the author should read (the artifacts are still present and usable).
 * - `invalid`: the program cannot be lowered; diagnostics say why, in the
 *   author's language, each anchored to a source line and column.
 *
 * Every diagnostic points at SOURCE coordinates, never at lowered IR paths.
 */

import type { UdlIssueCode } from "@hyperscale0/udl";
import { lineColIn, lineIndex } from "./ast.ts";
import {
  buildCostManifest,
  type UdlCostManifest,
  type UdlCostTable,
} from "./cost.ts";
import { lowerGeneralProgram, type OriginMapEntry } from "./emit.ts";
import {
  resolveProgramModules,
  type HsxCompilerHost,
  type ModuleOrigin,
} from "./modules.ts";
import { parseProgram } from "./parse.ts";
import { checkGeneralProgram } from "./typecheck.ts";

type Json = Record<string, unknown>;

type CompileVerdict = "invalid" | "valid" | "warning";

export interface CompileDiagnostic {
  /** 1-indexed source column. */
  readonly column: number;
  /** Imported module file when the diagnostic belongs to module source. */
  readonly file?: string;
  /** 1-indexed source line. */
  readonly line: number;
  readonly message: string;
  /** Source offsets in UTF-16 code units, matching parser and checker spans. */
  readonly span: { readonly end: number; readonly start: number };
  readonly code?: string;
  readonly fix?: string;
  /** Canonical UDL path when lowering rejected an emitted clause. */
  readonly path?: string;
  /** UDL validator category when the emitter rejected its candidate document. */
  readonly udlCode?: UdlIssueCode;
  readonly severity: "error" | "warning";
  /** The stage that raised it: parse, check, or lower. */
  readonly stage: "bind" | "check" | "lower" | "parse" | "typecheck";
}

interface CompileArtifacts {
  /** The canonical UDL document. */
  readonly document: Json;
  /** Canonical UDL paths bound to their narrowest authored source terms. */
  readonly originMap: readonly CompileOriginMapEntry[];
  /** Deterministic compile-time cost, pinned to one versioned table. */
  readonly costManifest: UdlCostManifest;
}

export interface CompileOptions extends HsxCompilerHost {
  readonly composesCatalogBlueprint?: boolean;
  readonly costTable?: UdlCostTable;
}

export interface CompileOriginMapEntry {
  readonly path: string;
  readonly span: {
    /** Exclusive UTF-8 byte offset. */
    readonly end: number;
    /** 1-indexed source column. */
    readonly column: number;
    /** 1-indexed source line. */
    readonly line: number;
    /** Inclusive UTF-8 byte offset. */
    readonly start: number;
  };
}

export interface CompileResult {
  /** Present exactly when the verdict is not `invalid`. */
  readonly artifacts?: CompileArtifacts;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly verdict: CompileVerdict;
}

export function compile(
  source: string,
  options: CompileOptions = {},
): CompileResult {
  const diagnostics: CompileDiagnostic[] = [];
  // Scanned once here rather than per diagnostic: a source can carry one
  // diagnostic per two bytes, and rescanning from offset zero for each one
  // made a 128 KB file cost 2.4 seconds of coordinate arithmetic.
  const lines = lineIndex(source);
  const byteOffsets = utf8OffsetIndex(source);
  const at = (
    stage: CompileDiagnostic["stage"],
    severity: CompileDiagnostic["severity"],
    message: string,
    span: { readonly end: number; readonly start: number },
    details?: {
      readonly code: string;
      readonly fix: string;
      readonly path?: string;
      readonly udlCode?: UdlIssueCode;
    },
    origin?: ModuleOrigin,
  ): void => {
    const position = origin ?? lineColIn(lines, span.start);
    diagnostics.push({
      column: position.column,
      ...(origin ? { file: origin.moduleName } : {}),
      line: position.line,
      message,
      span: { ...span },
      ...(details ? details : {}),
      severity,
      stage,
    });
  };

  const parsed = parseProgram(source);
  for (const diagnostic of parsed.diagnostics) {
    at(
      "parse",
      "error",
      diagnostic.message,
      diagnostic.span,
      diagnostic.code && diagnostic.fix
        ? { code: diagnostic.code, fix: diagnostic.fix }
        : undefined,
    );
  }
  if (parsed.diagnostics.length > 0) {
    return { diagnostics, verdict: "invalid" };
  }

  const resolved = resolveProgramModules(parsed.program, options);
  if (!resolved.ok) {
    for (const issue of resolved.issues) {
      at("bind", "error", issue.message, issue.span, {
        code: issue.code,
        fix: issue.fix,
      });
    }
    return { diagnostics, verdict: "invalid" };
  }
  const checked = checkGeneralProgram(
    resolved.program,
    options.publishedCatalog
      ? { publishedCatalog: options.publishedCatalog }
      : {},
  );
  for (const diagnostic of checked.diagnostics) {
    const moduleOrigin = resolved.origins.get(diagnostic.span);
    at(
      diagnostic.code === "HSX1001" ? "bind" : "typecheck",
      diagnostic.severity,
      diagnostic.message,
      diagnostic.span,
      { code: diagnostic.code, fix: diagnostic.fix },
      moduleOrigin,
    );
  }
  if (!checked.program) return { diagnostics, verdict: "invalid" };
  const cost = buildCostManifest(
    checked.program,
    options.costTable,
    options.composesCatalogBlueprint ?? false,
  );
  if (!cost.ok) {
    for (const diagnostic of cost.diagnostics) {
      at(
        "typecheck",
        diagnostic.severity,
        diagnostic.message,
        diagnostic.span,
        { code: diagnostic.code, fix: diagnostic.fix },
      );
    }
    return { diagnostics, verdict: "invalid" };
  }
  const lowered = lowerGeneralProgram(checked.program);
  if (!lowered.ok) {
    for (const issue of lowered.issues) {
      at("lower", "error", issue.message, issue.span, {
        code: issue.code,
        fix: issue.fix,
        path: issue.path,
        ...(issue.udlCode ? { udlCode: issue.udlCode } : {}),
      });
    }
    return { diagnostics, verdict: "invalid" };
  }
  const compileOrigin = (entry: OriginMapEntry): CompileOriginMapEntry => {
    const position = lineColIn(lines, entry.span.start);
    return {
      path: entry.path,
      span: {
        column: position.column,
        end:
          byteOffsets[entry.span.end] ?? byteOffsets[byteOffsets.length - 1]!,
        line: position.line,
        start: byteOffsets[entry.span.start] ?? 0,
      },
    };
  };
  return {
    artifacts: {
      document: lowered.value.document,
      costManifest: cost.manifest,
      originMap: lowered.value.originMap.map(compileOrigin),
    },
    diagnostics,
    verdict: diagnostics.length > 0 ? "warning" : "valid",
  };
}

function utf8OffsetIndex(source: string): Uint32Array {
  const offsets = new Uint32Array(source.length + 1);
  let bytes = 0;
  for (let index = 0; index < source.length; index += 1) {
    offsets[index] = bytes;
    const codePoint = source.codePointAt(index) as number;
    if (codePoint > 0xffff) {
      offsets[index + 1] = bytes;
      bytes += 4;
      index += 1;
    } else if (codePoint > 0x7ff) bytes += 3;
    else if (codePoint > 0x7f) bytes += 2;
    else bytes += 1;
  }
  offsets[source.length] = bytes;
  return offsets;
}
