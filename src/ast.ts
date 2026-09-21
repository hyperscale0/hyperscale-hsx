export interface Span {
  start: number;
  end: number;
}
export interface Diagnostic {
  source?: string;
  related?: readonly { source: string; span: Span; message: string }[];
  code: string;
  message: string;
  fix: string;
  span: Span;
}
export type Expr =
  | {
      kind:
        | "name"
        | "text"
        | "number"
        | "money"
        | "percent"
        | "duration"
        | "date";
      value: string;
      span: Span;
    }
  | { kind: "list"; items: Expr[]; span: Span }
  | { kind: "block"; entries: Entry[]; span: Span }
  | { kind: "call"; name: string; args: Expr[]; span: Span }
  | {
      kind: "type";
      name: string;
      target?: string;
      owner?: string;
      optional: boolean;
      many?: boolean;
      span: Span;
    }
  | { kind: "default"; type: Expr; value: Expr; span: Span }
  | { kind: "capped"; rate: Expr; cap: Expr; span: Span };
export interface Entry {
  key: string;
  value: Expr;
  span: Span;
}
export interface InstrumentDecl {
  kind: "instrument";
  name: string;
  parameters: Entry[];
  body: Extract<Expr, { kind: "block" }>;
  span: Span;
}
export interface AssignmentDecl {
  kind: "assignment";
  name: string;
  target: string;
  body: Extract<Expr, { kind: "block" }>;
  span: Span;
}
export interface ObjectDecl {
  kind: "object";
  name: string;
  title: string;
  body: Extract<Expr, { kind: "block" }>;
  span: Span;
}
export type Decl =
  | InstrumentDecl
  | AssignmentDecl
  | ObjectDecl
  | {
      kind: "party";
      name: string;
      partyKind: string;
      role?: string;
      span: Span;
    }
  | { kind: "use"; name: string; span: Span }
  | { kind: "expose"; target: string; name: string; span: Span }
  | { kind: "hide"; target: string; span: Span };
export interface Program {
  name: string;
  title: string;
  currency: string;
  header: boolean;
  decls: Decl[];
  span: Span;
}
export const lineColAt = (source: string, offset: number) => {
  const before = source.slice(0, offset);
  return {
    line: before.split("\n").length,
    column: offset - before.lastIndexOf("\n"),
  };
};
export function byteOffsetToCodeUnit(source: string, offset: number): number {
  let bytes = 0;
  let units = 0;
  for (const c of source) {
    bytes += new TextEncoder().encode(c).length;
    if (bytes > offset) break;
    units += c.length;
  }
  return units;
}
export type BlockExpr = Extract<Expr, { kind: "block" }>;
