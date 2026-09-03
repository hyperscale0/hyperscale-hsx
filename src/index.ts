export {
  compile,
  type CompileDiagnostic,
  type CompileOptions,
  type CompileOriginMapEntry,
  type CompileResult,
} from "./compile.ts";
export {
  buildUdlCostManifest,
  computeUdlFixedCost,
  evaluateUdlCostManifest,
  type HsxEffectKind,
  type UdlCostManifest,
  type UdlCostTable,
} from "./cost.ts";
export {
  hsxDiagnostics,
  type HsxDiagnosticCatalogEntry,
} from "./diagnostics.ts";
export type { HsxCompilerHost, ModuleSource } from "./modules.ts";
export { format, type FormatResult } from "./format.ts";
export { KEYWORDS } from "./lex.ts";
export {
  overrideProgramEntries,
  type ProgramEntryOverride,
  type ProgramEntryOverrideIssue,
  type ProgramEntryOverrideValue,
} from "./entry-overrides.ts";
export { type OriginMapEntry } from "./emit.ts";
export { lowerGeneralProgram } from "./emit.ts";
export { parseProgram } from "./parse.ts";
export { checkGeneralProgram, type GeneralCheckOptions } from "./typecheck.ts";
export {
  byteOffsetToCodeUnit,
  type BlockExpr,
  type ExposeDecl,
  type Program,
  type ProgramDecl,
  type UseDecl,
} from "./ast.ts";
export { bundledStandardLibrary, type StandardLibrary } from "./std-library.ts";
