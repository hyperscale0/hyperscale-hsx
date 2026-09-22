import type { Diagnostic, Span } from "./ast.ts";
export const KEYWORDS = [
  "program",
  "header",
  "use",
  "party",
  "role",
  "currency",
  "instrument",
  "fields",
  "lifecycle",
  "action",
  "expose",
  "hide",
  "as",
  "cap",
  "of",
  "when",
  "constraints",
  "requires",
  "invariants",
  "moves",
  "from",
  "to",
  "in",
  "is",
  "has",
  "unique",
  "on",
  "count",
  "sum",
  "hours",
  "between",
  "and",
  "timezone",
  "evidence",
  "family",
  "check",
  "result",
  "maxAge",
  "instruction",
  "reserve",
  "post",
  "void",
  "capture",
  "boundary",
  "key",
  "fee",
  "shares",
  "object",
  "attach",
  "subject",
  "rename",
  "columns",
] as const;
export interface Token {
  kind: "name" | "number" | "string" | "date" | "punct" | "comment" | "eof";
  text: string;
  span: Span;
}
export function lex(source: string) {
  return scan(source, false);
}

/** The editor keeps comments and unfinished strings; compiler tokens stay unchanged. */
export function scan(
  source: string,
  editor = true,
): {
  tokens: Token[];
  diagnostics: Diagnostic[];
} {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    const tail = source.slice(index);
    const whitespace = /^\s+|^\/\/[^\n]*/.exec(tail);
    if (whitespace) {
      index += whitespace[0].length;
      if (editor && whitespace[0].startsWith("//"))
        tokens.push({
          kind: "comment",
          text: whitespace[0],
          span: { start, end: index },
        });
      continue;
    }
    const date =
      /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?/.exec(
        tail,
      );
    const number = /^-?\d+(?:\.\d+)?(?:%|ms|[smhdw])?/.exec(tail);
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(tail);
    let kind: Token["kind"];
    let text: string;
    if (date) {
      kind = "date";
      text = date[0];
    } else if (number) {
      kind = "number";
      text = number[0];
    } else if (name) {
      kind = "name";
      text = name[0];
    } else if (tail[0] === '"') {
      const quoted =
        // oxlint-disable-next-line no-control-regex -- JSON strings must escape raw control characters.
        /^"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/.exec(
          tail,
        );
      if (!quoted) {
        diagnostics.push({
          code: "HSX1000",
          message: "unclosed or invalid string",
          fix: "close the string and use JSON escapes",
          span: { start, end: start + 1 },
        });
        if (editor) {
          const unfinished =
            /^"(?:[^"\\\n]|\\[^\n]?)*(?:"|(?=\n)|$)/.exec(tail)?.[0] ?? '"';
          index += unfinished.length;
          tokens.push({
            kind: "string",
            text: unfinished,
            span: { start, end: index },
          });
        } else index++;
        continue;
      }
      kind = "string";
      text = quoted[0];
    } else if (/^(==|!=|<=|>=)/.test(tail)) {
      kind = "punct";
      text = tail.slice(0, 2);
    } else if (/^[{}()[\]:,;=<>?.|]/.test(tail)) {
      kind = "punct";
      text = tail[0]!;
    } else {
      diagnostics.push({
        code: "HSX1000",
        message: `unexpected character ${tail[0]}`,
        fix: "remove this character",
        span: { start, end: start + 1 },
      });
      index++;
      continue;
    }
    index += text.length;
    tokens.push({ kind, text, span: { start, end: index } });
  }
  tokens.push({ kind: "eof", text: "", span: { start: index, end: index } });
  return { tokens, diagnostics };
}
