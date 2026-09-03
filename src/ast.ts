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

const utf8Encoder = new TextEncoder();

/**
 * Convert a UTF-8 byte offset to a UTF-16 code-unit offset over a string.
 * Walks Unicode code points, counting UTF-8 bytes and UTF-16 code units.
 * Clamps to [0, source.length].
 */
export function byteOffsetToCodeUnit(
  source: string,
  byteOffset: number,
): number {
  if (byteOffset <= 0) return 0;
  let currentByte = 0;
  let codeUnit = 0;

  for (const char of source) {
    const charBytes = utf8Encoder.encode(char).length;
    if (currentByte + charBytes > byteOffset) {
      return codeUnit;
    }
    currentByte += charBytes;
    codeUnit += char.length;
    if (currentByte === byteOffset) {
      return codeUnit;
    }
  }

  return source.length;
}

/**
 * One source scanned once, so many offsets resolve without rescanning it.
 * `lineColAt` walks from offset zero every time, which turns a run of d
 * diagnostics over an n-byte source into O(n*d) work. A caller holding this
 * pays O(n) once and O(log n) per offset.
 */
export interface LineIndex {
  /** Source length, so `lineColIn` clamps exactly as `lineColAt` does. */
  readonly length: number;
  /** Offset of the first character of each line, ascending. Line 1 starts at 0. */
  readonly starts: readonly number[];
}

/** Scan a source once for the offset every line starts at. */
export function lineIndex(source: string): LineIndex {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return { length: source.length, starts };
}

/**
 * Resolve one offset against a prebuilt index. Returns exactly what
 * `lineColAt` returns for the same source and offset.
 */
export function lineColIn(index: LineIndex, offset: number): LineCol {
  const clamped = Math.max(0, Math.min(offset, index.length));
  let low = 0;
  let high = index.starts.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if ((index.starts[middle] as number) <= clamped) low = middle;
    else high = middle - 1;
  }
  return { column: clamped - (index.starts[low] as number) + 1, line: low + 1 };
}

// --- Expressions -----------------------------------------------------------

export interface IdentExpr {
  readonly kind: "ident";
  readonly name: string;
  /** A literal quoted block key keeps its exact spelling during JSON lowering. */
  readonly quoted?: boolean;
  readonly span: Span;
}

export interface StringExpr {
  readonly kind: "string";
  readonly span: Span;
  readonly value: string;
}

export interface NumberExpr {
  readonly kind: "number";
  /** The literal exactly as written, e.g. "99.5". Interpretation is typed later. */
  readonly raw: string;
  readonly span: Span;
}

export interface BooleanExpr {
  readonly kind: "boolean";
  readonly span: Span;
  readonly value: boolean;
}

/** A currency-indexed literal. The checker converts it to integer minor units. */
export interface MoneyExpr {
  readonly currency: IdentExpr;
  readonly kind: "money";
  readonly raw: string;
  readonly span: Span;
}

/** A dotted name used for modules, UDL operations, and field paths. */
export interface PathExpr {
  readonly kind: "path";
  readonly parts: readonly IdentExpr[];
  readonly span: Span;
}

/** A nominal type application such as `money<SAR>` or `ref<invoice>`. */
export interface TypeApplyExpr {
  readonly args: readonly Expr[];
  readonly callee: IdentExpr;
  readonly kind: "type_apply";
  readonly span: Span;
}

/** A general instrument or constant application, with optional type arguments. */
export interface ApplyExpr {
  readonly args: readonly Expr[];
  readonly callee: PathExpr;
  readonly kind: "apply";
  readonly span: Span;
  readonly typeArgs: readonly Expr[];
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
 * An exit amount chosen by a decision port and bounded by stored money:
 * `decided { field: damageAmount, bound: depositAmount, remainder: return }`.
 */
export interface DecidedAmountExpr {
  readonly body: BlockExpr;
  readonly kind: "decided_amount";
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
 * `retention.release`, one settlement naming another settlement's declared
 * referenceable exit. The checker resolves it wholly before lowering.
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
export interface BindingExpr {
  readonly kind: "binding";
  readonly name: IdentExpr;
  readonly span: Span;
  readonly type: Expr;
}

export type Expr =
  | ApplyExpr
  | BindingExpr
  | BlockExpr
  | BooleanExpr
  | CallExpr
  | DecidedAmountExpr
  | IdentExpr
  | ListExpr
  | MoneyExpr
  | NumberExpr
  | PathExpr
  | PercentExpr
  | PortRefExpr
  | SettlementRefExpr
  | StringExpr
  | TypeApplyExpr;

// --- Entries ---------------------------------------------------------------

/**
 * One keyed entry inside a declaration body. Three surface shapes normalize
 * here: `payer: buyer` (key + value), `fees { ... }` (key + block value),
 * and `on_cancel(funded) { ... }` (key + qualifiers + block value).
 */
export interface Entry {
  /** `for item in bound { ... }`, expanded before binding or UDL lowering. */
  readonly iteration?: {
    readonly binding: IdentExpr;
    readonly bound: Expr;
  };
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

/** `use held_settlement` selects one published catalog instrument. */
export interface UseDecl {
  readonly instrument: IdentExpr;
  readonly kind: "use";
  readonly span: Span;
}

/** `expose held_settlement.release as releaseFunds` names a public action. */
export interface ExposeDecl {
  readonly action: IdentExpr;
  readonly instrument: IdentExpr;
  readonly kind: "expose";
  readonly publicName: IdentExpr;
  readonly span: Span;
}

/** `import { held_payment } from "std/settlements"`. */
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

/** A full UDL subject-kind declaration. `asset` remains shorthand for this form. */
export interface SubjectDecl {
  readonly body: BlockExpr;
  readonly kind: "subject";
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

/** `module std.settlements` gives a file its importable module name. */
export interface ModuleDecl {
  readonly kind: "module";
  readonly name: PathExpr;
  readonly span: Span;
}

export interface TypeParameter {
  readonly name: IdentExpr;
  readonly span: Span;
}

export interface Parameter {
  readonly name: IdentExpr;
  readonly span: Span;
  readonly type: Expr;
}

/** The single general instrument definition form. */
export interface InstrumentDecl {
  readonly body: BlockExpr;
  /** Module-local declarations carried only while this template is bound. */
  readonly declarationScope?: readonly ApplicationScopeDecl[];
  readonly exported: boolean;
  /** True when the source declared a parameter list, including an empty `()`. */
  readonly hasParameterList: boolean;
  readonly kind: "instrument";
  readonly name: IdentExpr;
  readonly parameters: readonly Parameter[];
  readonly span: Span;
  readonly typeParameters: readonly TypeParameter[];
}

/** Instantiation of an exported parameterized instrument. */
export interface InstrumentApplyDecl {
  readonly application: ApplyExpr;
  /** Module-local declarations carried only while this application is bound. */
  readonly declarationScope?: readonly ApplicationScopeDecl[];
  readonly exported: boolean;
  readonly kind: "instrument_apply";
  readonly metadata?: BlockExpr;
  readonly name: IdentExpr;
  readonly span: Span;
}

export interface TypeDecl {
  readonly exported: boolean;
  readonly kind: "type";
  readonly name: IdentExpr;
  readonly span: Span;
  readonly value: Expr;
}

export interface ConstDecl {
  readonly exported: boolean;
  readonly kind: "const";
  readonly name: IdentExpr;
  readonly span: Span;
  readonly type?: Expr;
  readonly value: Expr;
}

export type ApplicationScopeDecl =
  | ConstDecl
  | InstrumentDecl
  | PartyDecl
  | PortDecl
  | TypeDecl;

export type Decl =
  | AssetDecl
  | ConstDecl
  | ExposeDecl
  | ImportDecl
  | InstrumentApplyDecl
  | InstrumentDecl
  | ModuleDecl
  | PartyDecl
  | PortDecl
  | ProgramDecl
  | SubjectDecl
  | TypeDecl
  | UseDecl;

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
  readonly code?: string;
  readonly fix?: string;
  readonly message: string;
  readonly span: Span;
}
