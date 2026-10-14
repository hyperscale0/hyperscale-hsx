import { lineColAt, type Diagnostic, type Span } from "./ast.ts";

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

export interface Site {
  span: Span;
  source?: string;
}
/**
 * One thing given twice. The message names both sites as line:column, and
 * both values when they differ; the first site goes in `related`.
 * `texts` holds each source by name, "program" for the program itself.
 */
export function conflict(
  texts: ReadonlyMap<string, string>,
  subject: string,
  first: Site,
  second: Site,
  fix: string,
  {
    values,
    code = "HSX1001",
  }: { values?: readonly [Site, Site]; code?: string } = {},
): never {
  const text = (site: Site) => texts.get(site.source ?? "program") ?? "";
  const at = (site: Site) => {
    const { line, column } = lineColAt(text(site), site.span.start);
    const source = site.source ?? "program";
    return `${source === (second.source ?? "program") ? "" : `${source} `}${line}:${column}`;
  };
  const [before, after] = (values ?? []).map((site) =>
    text(site).slice(site.span.start, site.span.end).trim(),
  );
  throw new CompileFailure({
    code,
    message:
      before && after && before !== after
        ? `${subject} with different values: ${before} at ${at(first)} and ${after} at ${at(second)}`
        : `${subject}, at ${at(first)} and ${at(second)}`,
    fix,
    span: second.span,
    ...(second.source ? { source: second.source } : {}),
    related: [
      {
        source: first.source ?? "program",
        span: first.span,
        message: "First given here",
      },
    ],
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
