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
  | {
      kind: "call";
      name: string;
      args: Expr[];
      optional?: boolean;
      span: Span;
    }
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
  | { kind: "expose"; target: string; name: string; span: Span };
/** A name as written, so a check diagnostic points at it. */
export interface Named {
  name: string;
  span: Span;
}
/** One statement of a `check` block. Every step may end with `balances { }`. */
export type CheckStatement = { span: Span; balances?: BlockExpr } & (
  | {
      kind: "customer";
      id: Named;
      title: string;
      organization: boolean;
      fund?: Expr;
      binds: Named[];
    }
  | {
      kind: "clock";
      at: Expr;
      until?: {
        object: Named;
        attachment?: Named;
        recordPath?: string;
        state: Named;
      };
    }
  | {
      kind: "object";
      id: Named;
      objectKind: Named;
      owner: Named;
      fields?: BlockExpr;
    }
  | {
      kind: "action";
      actor?: Named;
      object: Named;
      action: Named;
      input?: BlockExpr;
      fields?: BlockExpr;
      instance?: Named;
      remember?: Named;
      state?: Named;
      status?: Expr;
      code?: string;
    }
  | { kind: "close"; customer: Named }
  | { kind: "expect"; held?: Expr; pending?: BlockExpr }
);
export interface CheckDecl {
  name: string;
  statements: CheckStatement[];
  span: Span;
}
export interface Program {
  name: string;
  title: string;
  currency: string;
  header: boolean;
  decls: Decl[];
  /** Build data beside the document; compile never lowers them into it. */
  checks: CheckDecl[];
  span: Span;
}
export const lineColAt = (source: string, offset: number) => {
  const before = source.slice(0, offset);
  return {
    line: before.split("\n").length,
    column: offset - before.lastIndexOf("\n"),
  };
};
export type BlockExpr = Extract<Expr, { kind: "block" }>;
