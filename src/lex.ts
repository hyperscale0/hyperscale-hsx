/**
 * The HSX lexer. Hand-written, total: every input produces a token stream
 * ending in `eof`, with malformed stretches reported as diagnostics and
 * skipped. Tokens carry byte-offset spans; whitespace and `//` comments are
 * insignificant everywhere.
 */

import type { Diagnostic, Span } from "./ast.ts";

type TokenKind =
  | "eof"
  | "ident"
  | "keyword"
  | "number"
  | "percent"
  | "punct"
  | "string";

export const KEYWORDS = [
  "asset",
  "from",
  "import",
  "party",
  "port",
  "program",
  "settlement",
] as const;

export interface Token {
  readonly kind: TokenKind;
  readonly span: Span;
  /** Identifier name, keyword, punctuation glyph, or raw literal text. */
  readonly text: string;
  /** Decoded value for string literals; raw digits for numbers/percents. */
  readonly value: string;
}

const PUNCT = new Set(["{", "}", "(", ")", "[", "]", ":", ",", "=", "|", "."]);
const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);

// Case conventions (snake_case declarations, uppercase currency codes) are
// semantic rules the typechecker words per position; the lexer stays permissive.
const isIdentStart = (ch: string): boolean => /[A-Za-z]/.test(ch);
const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

export interface LexResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly tokens: readonly Token[];
}

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let index = 0;

  const push = (kind: TokenKind, start: number, text: string, value = text) => {
    tokens.push({ kind, span: { end: index, start }, text, value });
  };

  while (index < source.length) {
    const ch = source[index] as string;

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      index += 1;
      continue;
    }

    if (ch === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (PUNCT.has(ch)) {
      const start = index;
      index += 1;
      push("punct", start, ch);
      continue;
    }

    if (ch === '"') {
      const start = index;
      index += 1;
      let value = "";
      let closed = false;
      while (index < source.length) {
        const next = source[index] as string;
        if (next === '"') {
          index += 1;
          closed = true;
          break;
        }
        if (next === "\n") break;
        value += next;
        index += 1;
      }
      if (!closed) {
        diagnostics.push({
          message: "this string never closes; add the ending double quote",
          span: { end: index, start },
        });
      }
      push("string", start, source.slice(start, index), value);
      continue;
    }

    if (isDigit(ch)) {
      const start = index;
      while (index < source.length && isDigit(source[index] as string)) {
        index += 1;
      }
      if (source[index] === "." && isDigit(source[index + 1] ?? "")) {
        index += 1;
        while (index < source.length && isDigit(source[index] as string)) {
          index += 1;
        }
      }
      const raw = source.slice(start, index);
      if (source[index] === "%") {
        index += 1;
        push("percent", start, source.slice(start, index), raw);
      } else {
        push("number", start, raw, raw);
      }
      continue;
    }

    if (isIdentStart(ch)) {
      const start = index;
      while (index < source.length && isIdentPart(source[index] as string)) {
        index += 1;
      }
      const text = source.slice(start, index);
      push(KEYWORD_SET.has(text) ? "keyword" : "ident", start, text);
      continue;
    }

    const start = index;
    while (
      index < source.length &&
      !/[\sA-Za-z0-9_"]/.test(source[index] as string) &&
      !PUNCT.has(source[index] as string) &&
      !(source[index] === "/" && source[index + 1] === "/")
    ) {
      index += 1;
    }
    if (index === start) index += 1;
    diagnostics.push({
      message: `"${source.slice(start, index)}" is not part of the HSX language`,
      span: { end: index, start },
    });
  }

  tokens.push({
    kind: "eof",
    span: { end: source.length, start: source.length },
    text: "",
    value: "",
  });
  return { diagnostics, tokens };
}
