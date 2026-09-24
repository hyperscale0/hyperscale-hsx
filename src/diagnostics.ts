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

// Levenshtein distance where swapping two adjacent letters counts as one edit.
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}
/** " Did you mean `x`?" for the closest candidate within a third of the name's length, else "". */
export function didYouMean(
  name: string,
  candidates: readonly string[],
): string {
  const limit = Math.max(1, Math.floor(name.length / 3));
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return best === undefined ? "" : ` Did you mean \`${best}\`?`;
}
