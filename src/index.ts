export {
  compile,
  type CompileDiagnostic,
  type CompileResult,
  type CompileWarning,
  type CompileOriginMapEntry,
  type CompileTerm,
  type CompileTermOverride,
} from "./compile.ts";
export type { CompiledCheck, CompiledCheckStep } from "./checks.ts";
export {
  defaultToolchain,
  toolchain,
  type AdapterBindingTarget,
  type Toolchain,
} from "./toolchain.ts";
export type { ProviderAdapter } from "@hyperscale0/adl";
export { parseProgram } from "./parse.ts";
export { lex, KEYWORDS } from "./lex.ts";
export { format } from "./format.ts";
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

export { headerManifest, HEADER_NAMES, namedHeaders } from "./headers.ts";
export {
  templateGuide,
  templateIndex,
  type TemplateGuide,
  type TemplateIndexEntry,
} from "./template-guide.ts";
