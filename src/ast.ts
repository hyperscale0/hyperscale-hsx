/**
 * The HSX abstract syntax tree.
 *
 * Every node carries a byte-offset span into the original source. Spans are
 * the compiler's source-mapping currency: diagnostics at every later stage
 * (typecheck, lowering, verdicts) point at source coordinates, never at
 * lowered IR paths. Offsets convert to line/column via `lineColAt`.
 */

export interface Span {
  /** Inclusive start byte offset into the source text. */
  readonly start: number;
  /** Exclusive end byte offset into the source text. */
  readonly end: number;
}

export interface LineCol {
  /** 1-indexed line. */
  readonly line: number;
  /** 1-indexed column, counted in UTF-16 code units. */
  readonly column: number;
}

/** Convert a byte offset to a 1-indexed line/column position. */
export function lineColAt(source: string, offset: number): LineCol {
  let line = 1;
  let lineStart = 0;
  const clamped = Math.max(0, Math.min(offset, source.length));
  for (let index = 0; index < clamped; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { column: clamped - lineStart + 1, line };
}

// --- Expressions -----------------------------------------------------------

export interface IdentExpr {
  readonly kind: "ident";
  readonly name: string;
  readonly span: Span;
}

export interface StringExpr {
  readonly kind: "string";
  readonly span: Span;
  readonly value: string;
}

interface NumberExpr {
  readonly kind: "number";
  /** The literal exactly as written, e.g. "99.5". Interpretation is typed later. */
  readonly raw: string;
  readonly span: Span;
}

export interface PercentExpr {
  /** Exact basis points: 99.5% is 9950. Percents never round. */
  readonly bps: number;
  readonly kind: "percent";
  readonly raw: string;
  readonly span: Span;
}

/** A type or constructor application: `money(SAR)`, `id(vehicle)`. */
export interface CallExpr {
  readonly args: readonly Expr[];
  readonly callee: IdentExpr;
  readonly kind: "call";
  readonly span: Span;
}

/**
 * A reference to a decision port, optionally bounded (`port dispute within
 * P14D`) or carrying the date that decides when the port has not
 * (`port approve_release | at(releaseDueAt)`).
 */
export interface PortRefExpr {
  /** `| at(<field>)`, the stored date field that resolves an undecided hold. */
  readonly deadline?: IdentExpr;
  readonly kind: "port_ref";
  readonly name: IdentExpr;
  readonly span: Span;
  readonly within?: IdentExpr;
}

/**
 * `retention.release`, one settlement naming another settlement's exit. The
 * only cross-settlement reference the language has: it is resolved wholly at
 * check time, never by a caller at runtime.
 */
export interface SettlementRefExpr {
  readonly kind: "settlement_ref";
  /** The exit named on the owner, e.g. `release`. */
  readonly member: IdentExpr;
  /** The settlement being referenced. */
  readonly owner: IdentExpr;
  readonly span: Span;
}

export interface ListExpr {
  readonly items: readonly Expr[];
  readonly kind: "list";
  readonly span: Span;
}

/** A brace block of entries: `{ buyer: 1%, seller: 2% }`. */
export interface BlockExpr {
  readonly entries: readonly Entry[];
  readonly kind: "block";
  readonly span: Span;
}

/**
 * A named typed binding inside an expression position:
 * `amount: price: money(SAR)` binds the field name `price` to type
 * `money(SAR)`: the entry key is `amount`, the value is this binding.
 */
interface BindingExpr {
  readonly kind: "binding";
  readonly name: IdentExpr;
  readonly span: Span;
  readonly type: Expr;
}

export type Expr =
  | BindingExpr
  | BlockExpr
  | CallExpr
  | IdentExpr
  | ListExpr
  | NumberExpr
  | PercentExpr
  | PortRefExpr
  | SettlementRefExpr
  | StringExpr;

// --- Entries ---------------------------------------------------------------

/**
 * One keyed entry inside a declaration body. Three surface shapes normalize
 * here: `payer: buyer` (key + value), `fees { ... }` (key + block value),
 * and `on_cancel(funded) { ... }` (key + qualifiers + block value).
 */
export interface Entry {
  readonly key: IdentExpr;
  readonly qualifiers: readonly IdentExpr[];
  readonly span: Span;
  readonly value: Expr;
}

// --- Declarations ----------------------------------------------------------

/** `program used_car_escrow "Used-car escrow"` names the company program. */
export interface ProgramDecl {
  readonly kind: "program";
  readonly name: IdentExpr;
  readonly span: Span;
  readonly title?: StringExpr;
}

/** `import { held_payment } from "settlement"`. */
export interface ImportDecl {
  readonly from: StringExpr;
  readonly kind: "import";
  readonly names: readonly IdentExpr[];
  readonly span: Span;
}

/** `party buyer: person` with an optional attribute block. */
export interface PartyDecl {
  readonly attrs?: BlockExpr;
  readonly kind: "party";
  readonly name: IdentExpr;
  readonly partyKind: IdentExpr;
  readonly span: Span;
}

/** `asset vehicle: good { title_transfer: off_platform }`. */
export interface AssetDecl {
  readonly assetKind: IdentExpr;
  readonly attrs?: BlockExpr;
  readonly kind: "asset";
  readonly name: IdentExpr;
  readonly span: Span;
}

/** `settlement sale = held_payment { ... }`, an archetype instantiation. */
export interface SettlementDecl {
  readonly archetype: IdentExpr;
  readonly body: BlockExpr;
  readonly kind: "settlement";
  readonly name: IdentExpr;
  readonly span: Span;
}

/** `port confirm_handover { allowed: [buyer], ... }`. */
export interface PortDecl {
  readonly body: BlockExpr;
  readonly kind: "port";
  readonly name: IdentExpr;
  readonly span: Span;
}

export type Decl =
  | AssetDecl
  | ImportDecl
  | PartyDecl
  | PortDecl
  | ProgramDecl
  | SettlementDecl;

// --- Program ---------------------------------------------------------------

export interface Program {
  readonly decls: readonly Decl[];
  readonly span: Span;
}

// --- Diagnostics -----------------------------------------------------------

/**
 * A parse-stage problem, worded for the program's author. Parsing is total:
 * it never throws, it returns the best-effort tree plus these.
 */
export interface Diagnostic {
  readonly message: string;
  readonly span: Span;
}
