import type { Diagnostic, Span } from "./ast.ts";

export class CompileFailure extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}
export function fail(
  expr: { span: Span; source?: string },
  message: string,
  fix: string,
): never {
  return failWithCode(expr, "HSX1001", message, fix);
}
export function failWithCode(
  expr: { span: Span; source?: string },
  code: string,
  message: string,
  fix: string,
): never {
  throw new CompileFailure({
    code,
    message,
    fix,
    span: expr.span,
    ...(expr.source ? { source: expr.source } : {}),
  });
}
