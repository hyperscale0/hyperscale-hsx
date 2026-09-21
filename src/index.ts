export {
  compile,
  type CompileDiagnostic,
  type CompileOptions,
  type CompileResult,
  type CompileOriginMapEntry,
  type AdapterBindingTarget,
} from "./compile.ts";
export type { ProviderAdapter } from "@hyperscale0/adl";
export { parseProgram } from "./parse.ts";
export { lex, KEYWORDS } from "./lex.ts";
export { format } from "./format.ts";
export { bundledStandardLibrary, type StandardLibrary } from "./std-library.ts";
export { buildUdlCostManifest, type UdlCostManifest } from "./cost.ts";
export type {
  Program,
  Decl,
  AssignmentDecl,
  ObjectDecl,
  InstrumentDecl,
  Expr,
  Span,
  Diagnostic,
} from "./ast.ts";

export { headerManifest, HEADER_NAMES } from "./headers.ts";
