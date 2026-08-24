/**
 * The HSX parser. Recursive descent over the lexer's token stream, total:
 * it always returns a best-effort `Program` plus diagnostics, recovering at
 * the next top-level keyword after an error so one mistake never hides the
 * rest of the file. Diagnostics speak the author's language and point at
 * source spans.
 */

import type {
  AssetDecl,
  BlockExpr,
  Decl,
  Diagnostic,
  Entry,
  Expr,
  IdentExpr,
  ImportDecl,
  PartyDecl,
  PortDecl,
  Program,
  ProgramDecl,
  SettlementDecl,
  Span,
  StringExpr,
} from "./ast.ts";
import { lex, type Token } from "./lex.ts";
import { HSX_LIMITS } from "./limits.ts";

export interface ParseResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly program: Program;
}

export function parseProgram(source: string): ParseResult {
  // Measured before lexing. The ceiling counts UTF-8 bytes, so the encode is
  // the measurement rather than an extra step: `source.length` counts UTF-16
  // code units, which is a third of the size for CJK text.
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > HSX_LIMITS.maxSourceBytes) {
    return {
      diagnostics: [
        {
          message: `this file is ${sourceBytes} bytes; HSX reads at most ${HSX_LIMITS.maxSourceBytes}`,
          span: { end: 0, start: 0 },
        },
      ],
      program: { decls: [], span: { end: 0, start: 0 } },
    };
  }

  const lexed = lex(source);
  const parser = new Parser(lexed.tokens, [...lexed.diagnostics]);
  const program = parser.parseProgram(source.length);
  return { diagnostics: parser.diagnostics, program };
}

class Parser {
  readonly diagnostics: Diagnostic[];
  private readonly tokens: readonly Token[];
  private index = 0;
  private depth = 0;

  constructor(tokens: readonly Token[], diagnostics: Diagnostic[]) {
    this.tokens = tokens;
    this.diagnostics = diagnostics;
  }

  parseProgram(sourceLength: number): Program {
    const decls: Decl[] = [];
    while (!this.at("eof")) {
      const decl = this.parseDecl();
      if (decl) {
        decls.push(decl);
        continue;
      }
      this.recoverToDecl();
    }
    return { decls, span: { end: sourceLength, start: 0 } };
  }

  // --- Declarations --------------------------------------------------------

  private parseDecl(): Decl | undefined {
    const token = this.peek();
    if (token.kind !== "keyword" || token.text === "from") {
      this.error(
        token.span,
        token.kind === "eof"
          ? "the program ends unexpectedly"
          : `expected a declaration (program, import, party, asset, settlement, or port), found "${token.text}"`,
      );
      return undefined;
    }
    switch (token.text) {
      case "program":
        return this.parseProgramDecl();
      case "import":
        return this.parseImportDecl();
      case "party":
        return this.parsePartyDecl();
      case "asset":
        return this.parseAssetDecl();
      case "settlement":
        return this.parseSettlementDecl();
      case "port":
        return this.parsePortDecl();
      default:
        this.error(token.span, `"${token.text}" cannot start a declaration`);
        this.advance();
        return undefined;
    }
  }

  private parseProgramDecl(): ProgramDecl | undefined {
    const start = this.advance();
    const name = this.expectIdent("the program needs a snake_case name");
    if (!name) return undefined;
    let title: StringExpr | undefined;
    if (this.at("string")) {
      const token = this.advance();
      title = { kind: "string", span: token.span, value: token.value };
    }
    return {
      kind: "program",
      name,
      span: this.spanFrom(start.span),
      ...(title ? { title } : {}),
    };
  }

  private parseImportDecl(): ImportDecl | undefined {
    const start = this.advance();
    if (
      !this.expectPunct(
        "{",
        'import lists its names in braces: import { held_payment } from "settlement"',
      )
    ) {
      return undefined;
    }
    const names: IdentExpr[] = [];
    while (!this.atPunct("}") && !this.at("eof")) {
      const name = this.expectIdent("expected an imported name");
      if (!name) return undefined;
      names.push(name);
      if (this.atPunct(",")) this.advance();
    }
    if (!this.expectPunct("}", "the import name list never closes")) {
      return undefined;
    }
    if (!this.at("keyword") || this.peek().text !== "from") {
      this.error(
        this.peek().span,
        'import needs from: import { held_payment } from "settlement"',
      );
      return undefined;
    }
    this.advance();
    if (!this.at("string")) {
      this.error(
        this.peek().span,
        'the import source must be a quoted module name like "settlement"',
      );
      return undefined;
    }
    const sourceToken = this.advance();
    if (names.length === 0) {
      this.error(start.span, "import brings in at least one name");
    }
    return {
      from: {
        kind: "string",
        span: sourceToken.span,
        value: sourceToken.value,
      },
      kind: "import",
      names,
      span: this.spanFrom(start.span),
    };
  }

  private parsePartyDecl(): PartyDecl | undefined {
    const start = this.advance();
    const name = this.expectIdent(
      "the party needs a name, like: party buyer: person",
    );
    if (!name) return undefined;
    if (
      !this.expectPunct(
        ":",
        `party ${name.name} needs a kind, like: party ${name.name}: person`,
      )
    ) {
      return undefined;
    }
    const partyKind = this.expectIdent(
      `expected a kind for party ${name.name}`,
    );
    if (!partyKind) return undefined;
    const attrs = this.atPunct("{") ? this.parseBlock() : undefined;
    return {
      ...(attrs ? { attrs } : {}),
      kind: "party",
      name,
      partyKind,
      span: this.spanFrom(start.span),
    };
  }

  private parseAssetDecl(): AssetDecl | undefined {
    const start = this.advance();
    const name = this.expectIdent(
      "the asset needs a name, like: asset vehicle: good",
    );
    if (!name) return undefined;
    if (
      !this.expectPunct(
        ":",
        `asset ${name.name} needs a kind, like: asset ${name.name}: good`,
      )
    ) {
      return undefined;
    }
    const assetKind = this.expectIdent(
      `expected a kind for asset ${name.name}`,
    );
    if (!assetKind) return undefined;
    const attrs = this.atPunct("{") ? this.parseBlock() : undefined;
    return {
      assetKind,
      ...(attrs ? { attrs } : {}),
      kind: "asset",
      name,
      span: this.spanFrom(start.span),
    };
  }

  private parseSettlementDecl(): SettlementDecl | undefined {
    const start = this.advance();
    const name = this.expectIdent(
      "the settlement needs a name, like: settlement sale = held_payment { ... }",
    );
    if (!name) return undefined;
    if (
      !this.expectPunct(
        "=",
        `settlement ${name.name} instantiates an archetype: settlement ${name.name} = held_payment { ... }`,
      )
    ) {
      return undefined;
    }
    const archetype = this.expectIdent(
      `expected an archetype name for settlement ${name.name}`,
    );
    if (!archetype) return undefined;
    if (!this.atPunct("{")) {
      this.error(
        this.peek().span,
        `settlement ${name.name} needs a body in braces`,
      );
      return undefined;
    }
    const body = this.parseBlock();
    if (!body) return undefined;
    return {
      archetype,
      body,
      kind: "settlement",
      name,
      span: this.spanFrom(start.span),
    };
  }

  private parsePortDecl(): PortDecl | undefined {
    const start = this.advance();
    const name = this.expectIdent(
      "the port needs a name, like: port confirm_handover { ... }",
    );
    if (!name) return undefined;
    if (!this.atPunct("{")) {
      this.error(this.peek().span, `port ${name.name} needs a body in braces`);
      return undefined;
    }
    const body = this.parseBlock();
    if (!body) return undefined;
    return { body, kind: "port", name, span: this.spanFrom(start.span) };
  }

  // --- Entries and expressions ---------------------------------------------

  /**
   * Every recursive edge in the grammar passes through `parseExpr` or
   * `parseBlock`: the list, block, call-argument, and binding-type branches of
   * one, and the block to entry to block cycle of the other. Guarding those
   * two entry points is therefore the whole ceiling, and the guard lives in
   * one place instead of five.
   *
   * The budget counts those entries, not source levels, and the two are not
   * the same number: `k { ... }` spends one per level, while `k: { ... }`
   * spends two because the colon branch enters `parseExpr` and `parseExpr`
   * then enters `parseBlock`. So the message names a budget rather than a
   * depth. A builder told they exceeded "64 levels" would count 32 braces and
   * have nothing to act on.
   */
  private enterNesting(span: Span): boolean {
    if (this.depth >= HSX_LIMITS.maxNestingDepth) {
      this.error(
        span,
        `this nests past the parser's depth budget of ${HSX_LIMITS.maxNestingDepth}; flatten it`,
      );
      return false;
    }
    this.depth += 1;
    return true;
  }

  private parseBlock(): BlockExpr | undefined {
    if (!this.enterNesting(this.peek().span)) return undefined;
    const block = this.parseBlockUnguarded();
    this.depth -= 1;
    return block;
  }

  private parseBlockUnguarded(): BlockExpr | undefined {
    const open = this.advance();
    const entries: Entry[] = [];
    while (!this.atPunct("}") && !this.at("eof")) {
      const before = this.index;
      const entry = this.parseEntry();
      if (!entry) {
        this.recoverInBlock();
        // recoverInBlock bails without consuming when it lands on a depth-0
        // keyword (e.g. `from` used as an entry key), and a failed
        // parseEntry may not have consumed either. Without forced progress
        // this loop never terminates.
        if (this.index === before) this.advance();
        continue;
      }
      entries.push(entry);
      if (this.atPunct(",")) this.advance();
    }
    if (!this.expectPunct("}", "this block never closes; add the matching }")) {
      return { entries, kind: "block", span: this.spanFrom(open.span) };
    }
    return { entries, kind: "block", span: this.spanFrom(open.span) };
  }

  private parseEntry(): Entry | undefined {
    const key = this.expectIdent("expected an entry name here");
    if (!key) return undefined;

    const qualifiers: IdentExpr[] = [];
    if (this.atPunct("(")) {
      this.advance();
      while (!this.atPunct(")") && !this.at("eof")) {
        const qualifier = this.expectIdent(
          `expected a qualifier inside ${key.name}( ... )`,
        );
        if (!qualifier) return undefined;
        qualifiers.push(qualifier);
        if (this.atPunct(",")) this.advance();
      }
      if (!this.expectPunct(")", `${key.name}( ... ) never closes`)) {
        return undefined;
      }
    }

    let value: Expr | undefined;
    if (this.atPunct("{")) {
      value = this.parseBlock();
    } else if (this.atPunct(":")) {
      this.advance();
      value = this.parseExpr();
    } else {
      this.error(
        this.peek().span,
        `entry ${key.name} needs a value: either "${key.name}: <value>" or "${key.name} { ... }"`,
      );
      return undefined;
    }
    if (!value) return undefined;
    return {
      key,
      qualifiers,
      span: { end: value.span.end, start: key.span.start },
      value,
    };
  }

  private parseExpr(): Expr | undefined {
    if (!this.enterNesting(this.peek().span)) return undefined;
    const expr = this.parseExprUnguarded();
    this.depth -= 1;
    return expr;
  }

  private parseExprUnguarded(): Expr | undefined {
    const token = this.peek();

    if (token.kind === "string") {
      this.advance();
      return { kind: "string", span: token.span, value: token.value };
    }
    if (token.kind === "number") {
      this.advance();
      return { kind: "number", raw: token.value, span: token.span };
    }
    if (token.kind === "percent") {
      this.advance();
      const bps = percentToBps(token.value);
      if (bps === undefined) {
        this.error(
          token.span,
          `${token.text} is finer than the money system can settle; percents go down to a hundredth (basis point), like 99.75%`,
        );
        return { bps: 0, kind: "percent", raw: token.value, span: token.span };
      }
      return { bps, kind: "percent", raw: token.value, span: token.span };
    }
    if (this.atPunct("[")) {
      const open = this.advance();
      const items: Expr[] = [];
      while (!this.atPunct("]") && !this.at("eof")) {
        const item = this.parseExpr();
        if (!item) return undefined;
        items.push(item);
        if (this.atPunct(",")) this.advance();
      }
      if (
        !this.expectPunct("]", "this list never closes; add the matching ]")
      ) {
        return undefined;
      }
      return { items, kind: "list", span: this.spanFrom(open.span) };
    }
    if (this.atPunct("{")) {
      return this.parseBlock();
    }
    if (token.kind === "keyword" && token.text === "port") {
      const start = this.advance();
      const name = this.expectIdent(
        "expected a port name after the port keyword",
      );
      if (!name) return undefined;
      let within: IdentExpr | undefined;
      if (this.at("ident") && this.peek().text === "within") {
        this.advance();
        within = this.expectIdent(
          "expected a fixed duration after within, like P14D",
        );
        if (!within) return undefined;
      }
      let deadline: IdentExpr | undefined;
      if (this.atPunct("|")) {
        this.advance();
        if (!this.at("ident") || this.peek().text !== "at") {
          this.error(
            this.peek().span,
            "after | comes the date the platform decides on, like: | at(releaseDueAt)",
          );
          return undefined;
        }
        this.advance();
        if (
          !this.expectPunct(
            "(",
            "at names its date field in parentheses: at(releaseDueAt)",
          )
        ) {
          return undefined;
        }
        deadline = this.expectIdent(
          "expected a stored date field inside at( ... ), like at(releaseDueAt)",
        );
        if (!deadline) return undefined;
        if (!this.expectPunct(")", "at( ... ) never closes")) return undefined;
      }
      return {
        ...(deadline ? { deadline } : {}),
        kind: "port_ref",
        name,
        span: this.spanFrom(start.span),
        ...(within ? { within } : {}),
      };
    }
    if (token.kind === "ident") {
      const ident = this.parseIdent();
      if (this.atPunct(".")) {
        this.advance();
        const member = this.expectIdent(
          `expected the exit after ${ident.name}., like ${ident.name}.release`,
        );
        if (!member) return undefined;
        return {
          kind: "settlement_ref",
          member,
          owner: ident,
          span: { end: member.span.end, start: ident.span.start },
        };
      }
      if (this.atPunct("(")) {
        this.advance();
        const args: Expr[] = [];
        while (!this.atPunct(")") && !this.at("eof")) {
          const arg = this.parseExpr();
          if (!arg) return undefined;
          args.push(arg);
          if (this.atPunct(",")) this.advance();
        }
        if (!this.expectPunct(")", `${ident.name}( ... ) never closes`)) {
          return undefined;
        }
        return {
          args,
          callee: ident,
          kind: "call",
          span: this.spanFrom(ident.span),
        };
      }
      if (this.atPunct(":")) {
        this.advance();
        const type = this.parseExpr();
        if (!type) return undefined;
        return {
          kind: "binding",
          name: ident,
          span: { end: type.span.end, start: ident.span.start },
          type,
        };
      }
      return ident;
    }

    this.error(
      token.span,
      token.kind === "eof"
        ? "the program ends where a value was expected"
        : `"${token.text}" is not a value HSX understands here`,
    );
    return undefined;
  }

  // --- Recovery ------------------------------------------------------------

  private recoverToDecl(): void {
    while (!this.at("eof")) {
      const token = this.peek();
      if (token.kind === "keyword" && token.text !== "from") return;
      this.advance();
    }
  }

  /** Skip to the next plausible entry start or the end of the block. */
  private recoverInBlock(): void {
    let depth = 0;
    while (!this.at("eof")) {
      const token = this.peek();
      if (token.kind === "punct") {
        if (token.text === "{" || token.text === "[" || token.text === "(")
          depth += 1;
        if (token.text === "}" || token.text === "]" || token.text === ")") {
          if (depth === 0) return;
          depth -= 1;
        }
        if (token.text === "," && depth === 0) {
          this.advance();
          return;
        }
      }
      if (token.kind === "keyword" && depth === 0) return;
      this.advance();
    }
  }

  // --- Token helpers -------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)] as Token;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== "eof") this.index += 1;
    return token;
  }

  private at(kind: Token["kind"]): boolean {
    return this.peek().kind === kind;
  }

  private atPunct(glyph: string): boolean {
    const token = this.peek();
    return token.kind === "punct" && token.text === glyph;
  }

  private parseIdent(): IdentExpr {
    const token = this.advance();
    return { kind: "ident", name: token.text, span: token.span };
  }

  private expectIdent(message: string): IdentExpr | undefined {
    if (this.at("ident")) return this.parseIdent();
    this.error(this.peek().span, message);
    return undefined;
  }

  private expectPunct(glyph: string, message: string): boolean {
    if (this.atPunct(glyph)) {
      this.advance();
      return true;
    }
    this.error(this.peek().span, message);
    return false;
  }

  private spanFrom(start: Span): Span {
    return { end: this.previous().span.end, start: start.start };
  }

  private error(span: Span, message: string): void {
    this.diagnostics.push({ message, span });
  }
}

/**
 * Convert a percent literal's raw digits to exact basis points, or refuse
 * when the literal is finer than a basis point. "99.5" -> 9950; "0.05" -> 5.
 */
export function percentToBps(raw: string): number | undefined {
  const [whole = "0", fraction = ""] = raw.split(".");
  if (fraction.length > 2) return undefined;
  const scaled = fraction.padEnd(2, "0");
  return Number(whole) * 100 + Number(scaled === "" ? "0" : scaled);
}
