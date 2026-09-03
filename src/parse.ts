/**
 * The HSX parser. Recursive descent over the lexer's token stream, total:
 * it always returns a best-effort `Program` plus diagnostics, recovering at
 * the next top-level keyword after an error so one mistake never hides the
 * rest of the file. Diagnostics speak the author's language and point at
 * source spans.
 */

import type {
  ApplyExpr,
  AssetDecl,
  BlockExpr,
  ConstDecl,
  Decl,
  Diagnostic,
  Entry,
  Expr,
  ExposeDecl,
  IdentExpr,
  ImportDecl,
  InstrumentApplyDecl,
  InstrumentDecl,
  ModuleDecl,
  Parameter,
  PartyDecl,
  PortDecl,
  Program,
  ProgramDecl,
  Span,
  StringExpr,
  SubjectDecl,
  TypeDecl,
  TypeParameter,
  UseDecl,
} from "./ast.ts";
import { lex, type Token } from "./lex.ts";
import { HSX_LIMITS } from "./limits.ts";

export interface ParseResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly program: Program;
}

type BlockContext = "general" | "lifecycle";

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

  const first = source.search(/\S/);
  if (first >= 0 && source[first] === "{") {
    return {
      diagnostics: [
        {
          code: "HSX1014",
          fix: "replace the JSON object with HSX declarations",
          message: "JSON is not HSX",
          span: { end: first + 1, start: first },
        },
      ],
      program: { decls: [], span: { end: source.length, start: 0 } },
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
      if (this.atPunct(";")) {
        this.advance();
        continue;
      }
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

  private parseDecl(exported = false): Decl | undefined {
    const token = this.peek();
    if (token.kind !== "keyword" || token.text === "from") {
      this.error(
        token.span,
        token.kind === "eof"
          ? "the program ends unexpectedly"
          : `expected a declaration (module, program, use, expose, import, party, asset, subject, instrument, settlement, type, const, or port), found "${token.text}"`,
      );
      return undefined;
    }
    switch (token.text) {
      case "export":
        this.advance();
        return this.parseDecl(true);
      case "module":
        return this.parseModuleDecl(exported);
      case "program":
        return this.parseProgramDecl();
      case "use":
        return this.parseUseDecl();
      case "expose":
        return this.parseExposeDecl();
      case "import":
        return this.parseImportDecl();
      case "party":
        return this.parsePartyDecl();
      case "asset":
        return this.parseAssetDecl();
      case "subject":
        return this.parseSubjectDecl(exported);
      case "instrument":
        return this.parseInstrumentDecl(exported);
      case "settlement":
        return this.parseSettlementDecl();
      case "port":
        return this.parsePortDecl();
      case "type":
        return this.parseTypeDecl(exported);
      case "const":
        return this.parseConstDecl(exported);
      default:
        this.error(token.span, `"${token.text}" cannot start a declaration`);
        this.advance();
        return undefined;
    }
  }

  private parseModuleDecl(exported: boolean): ModuleDecl | undefined {
    const start = this.advance();
    if (exported) {
      this.error(start.span, "a module declaration cannot be exported");
    }
    const name = this.parsePath("the module needs a dotted name");
    return name
      ? { kind: "module", name, span: this.spanFrom(start.span) }
      : undefined;
  }

  private parseInstrumentDecl(
    exported: boolean,
  ): InstrumentDecl | InstrumentApplyDecl | undefined {
    const start = this.advance();
    const name = this.expectIdent("the instrument needs a snake_case name");
    if (!name) return undefined;
    const typeParameters = this.parseTypeParameters();
    if (!typeParameters) return undefined;
    const hasParameterList = this.atPunct("(");
    const parameters = hasParameterList ? this.parseParameters() : [];
    if (!parameters) return undefined;
    if (this.atPunct("=")) {
      this.advance();
      const application = this.parseApplication();
      if (!application) return undefined;
      const metadata = this.atPunct("{") ? this.parseBlock() : undefined;
      return {
        application,
        exported,
        kind: "instrument_apply",
        ...(metadata ? { metadata } : {}),
        name,
        span: this.spanFrom(start.span),
      };
    }
    if (!this.atPunct("{")) {
      this.error(
        this.peek().span,
        `instrument ${name.name} needs a body or an exported instrument application`,
      );
      return undefined;
    }
    const body = this.parseBlock();
    if (!body) return undefined;
    return {
      body,
      exported,
      hasParameterList,
      kind: "instrument",
      name,
      parameters,
      span: this.spanFrom(start.span),
      typeParameters,
    };
  }

  private parseTypeDecl(exported: boolean): TypeDecl | undefined {
    const start = this.advance();
    const name = this.expectIdent("the type needs a name");
    if (!name) return undefined;
    if (
      !this.expectPunct("=", `type ${name.name} needs = before its definition`)
    ) {
      return undefined;
    }
    const value = this.parseExpr();
    return value
      ? { exported, kind: "type", name, span: this.spanFrom(start.span), value }
      : undefined;
  }

  private parseConstDecl(exported: boolean): ConstDecl | undefined {
    const start = this.advance();
    const name = this.expectIdent("the constant needs a name");
    if (!name) return undefined;
    let type: Expr | undefined;
    if (this.atPunct(":")) {
      this.advance();
      type = this.parseExpr();
      if (!type) return undefined;
    }
    if (!this.expectPunct("=", `const ${name.name} needs = before its value`)) {
      return undefined;
    }
    const value = this.parseExpr();
    return value
      ? {
          exported,
          kind: "const",
          name,
          span: this.spanFrom(start.span),
          ...(type ? { type } : {}),
          value,
        }
      : undefined;
  }

  private parseTypeParameters(): TypeParameter[] | undefined {
    if (!this.atPunct("<")) return [];
    this.advance();
    const parameters: TypeParameter[] = [];
    while (!this.atPunct(">") && !this.at("eof")) {
      const name = this.expectIdent("expected a type parameter");
      if (!name) return undefined;
      parameters.push({ name, span: name.span });
      if (this.atPunct(",")) this.advance();
    }
    return this.expectPunct(">", "the type parameter list never closes")
      ? parameters
      : undefined;
  }

  private parseParameters(): Parameter[] | undefined {
    this.advance();
    const parameters: Parameter[] = [];
    while (!this.atPunct(")") && !this.at("eof")) {
      const name = this.expectIdent("expected a parameter name");
      if (!name) return undefined;
      if (!this.expectPunct(":", `parameter ${name.name} needs a type`)) {
        return undefined;
      }
      const type = this.parseExpr();
      if (!type) return undefined;
      parameters.push({
        name,
        span: { start: name.span.start, end: type.span.end },
        type,
      });
      if (this.atPunct(",")) this.advance();
    }
    return this.expectPunct(")", "the parameter list never closes")
      ? parameters
      : undefined;
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

  private parseUseDecl(): UseDecl | undefined {
    const start = this.advance();
    const instrument = this.expectIdent(
      "use needs a published instrument id, like: use held_settlement",
    );
    return instrument
      ? { instrument, kind: "use", span: this.spanFrom(start.span) }
      : undefined;
  }

  private parseExposeDecl(): ExposeDecl | undefined {
    const start = this.advance();
    const instrument = this.expectIdent(
      "expose needs an instrument action, like: expose held_settlement.release as releaseFunds",
    );
    if (!instrument) return undefined;
    if (
      !this.expectPunct(
        ".",
        "expose separates the instrument and action with .",
      )
    ) {
      return undefined;
    }
    const action = this.expectName(
      "expose needs an action after the instrument id",
    );
    if (!action) return undefined;
    if (!this.at("keyword") || this.peek().text !== "as") {
      this.error(
        this.peek().span,
        "expose needs as before its public action name",
      );
      return undefined;
    }
    this.advance();
    const publicName = this.expectIdent(
      "expose needs a camelCase public action name",
    );
    return publicName
      ? {
          action,
          instrument,
          kind: "expose",
          publicName,
          span: this.spanFrom(start.span),
        }
      : undefined;
  }

  private parseImportDecl(): ImportDecl | undefined {
    const start = this.advance();
    if (
      !this.expectPunct(
        "{",
        'import lists its names in braces: import { held_payment } from "std/settlements"',
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
        'import needs from: import { held_payment } from "std/settlements"',
      );
      return undefined;
    }
    this.advance();
    if (!this.at("string")) {
      this.error(
        this.peek().span,
        'the import source must be a quoted module name like "std/settlements"',
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

  private parseSubjectDecl(exported: boolean): SubjectDecl | undefined {
    const start = this.advance();
    if (exported) {
      this.error(start.span, "a subject declaration cannot be exported");
    }
    const name = this.expectIdent("the subject needs a snake_case kind name");
    if (!name) return undefined;
    if (!this.atPunct("{")) {
      this.error(this.peek().span, `subject ${name.name} needs a body`);
      return undefined;
    }
    const body = this.parseBlock();
    return body
      ? { body, kind: "subject", name, span: this.spanFrom(start.span) }
      : undefined;
  }

  private parseSettlementDecl(): InstrumentApplyDecl | undefined {
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
      application: {
        args: body.entries.map((row) => ({
          kind: "binding" as const,
          name: row.key,
          span: row.value.span,
          type: row.value,
        })),
        callee: { kind: "path", parts: [archetype], span: archetype.span },
        kind: "apply",
        span: { start: archetype.span.start, end: body.span.end },
        typeArgs: [],
      },
      exported: false,
      kind: "instrument_apply",
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

  private parseBlock(context: BlockContext = "general"): BlockExpr | undefined {
    if (!this.enterNesting(this.peek().span)) return undefined;
    const block = this.parseBlockUnguarded(context);
    this.depth -= 1;
    return block;
  }

  private parseBlockUnguarded(context: BlockContext): BlockExpr | undefined {
    const open = this.advance();
    const entries: Entry[] = [];
    while (!this.atPunct("}") && !this.at("eof")) {
      if (this.atPunct(";") || this.atPunct(",")) {
        this.advance();
        continue;
      }
      const before = this.index;
      const entry = this.parseEntry(context);
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
      if (this.atPunct(",") || this.atPunct(";")) this.advance();
    }
    if (!this.expectPunct("}", "this block never closes; add the matching }")) {
      return { entries, kind: "block", span: this.spanFrom(open.span) };
    }
    return { entries, kind: "block", span: this.spanFrom(open.span) };
  }

  private parseEntry(context: BlockContext): Entry | undefined {
    const token = this.peek();
    const key =
      token.kind === "string"
        ? (() => {
            this.advance();
            return {
              kind: "ident" as const,
              name: token.value,
              quoted: !token.value.includes("["),
              span: token.span,
            };
          })()
        : this.isName(token) && (token.text === "action" || token.text === "on")
          ? this.parseIdent()
          : this.parseTemplatedName("expected an entry name here");
    if (!key) return undefined;

    const qualifiers: IdentExpr[] = [];
    if (key.name === "for") {
      const binding = this.expectIdent("for needs a compile-time binding name");
      const inWord = binding
        ? this.expectName("for needs in before its finite bound")
        : undefined;
      if (!binding || inWord?.name !== "in") {
        this.error(
          this.peek().span,
          "write `for item in <finite bound> { ... }`",
        );
        return undefined;
      }
      const bound = this.parseExpr();
      if (!bound || !this.atPunct("{")) {
        this.error(
          this.peek().span,
          "a bounded comprehension needs a body in braces",
        );
        return undefined;
      }
      const value = this.parseBlock(context);
      return value
        ? {
            iteration: { binding, bound },
            key,
            qualifiers,
            span: { start: key.span.start, end: value.span.end },
            value,
          }
        : undefined;
    }
    if (
      key.name === "action" &&
      (this.isName(this.peek()) || this.atPunct("["))
    ) {
      const action = this.parseTemplatedName("action needs a name");
      if (!action) return undefined;
      qualifiers.push(action);
      if (!this.atPunct("{")) {
        this.error(
          this.peek().span,
          `action ${qualifiers[0]?.name ?? ""} needs a body`,
        );
        return undefined;
      }
      const value = this.parseBlock();
      return value
        ? {
            key,
            qualifiers,
            span: { start: key.span.start, end: value.span.end },
            value,
          }
        : undefined;
    }
    if (context === "lifecycle" && key.name === "states") {
      const items: Expr[] = [];
      while (!this.atPunct(";") && !this.atPunct("}") && !this.at("eof")) {
        const state = this.parseTemplatedName("expected a lifecycle state");
        if (!state) return undefined;
        items.push(state);
      }
      const end = items.at(-1)?.span.end ?? key.span.end;
      return {
        key,
        qualifiers,
        span: { start: key.span.start, end },
        value: { items, kind: "list", span: { start: key.span.end, end } },
      };
    }
    if (context === "lifecycle" && key.name === "initial") {
      const value = this.parseTemplatedName(
        "initial needs one declared lifecycle state",
      );
      return value
        ? {
            key,
            qualifiers,
            span: { start: key.span.start, end: value.span.end },
            value,
          }
        : undefined;
    }
    if (context === "lifecycle" && key.name === "parked") {
      const state = this.parseTemplatedName("parked needs a lifecycle state");
      if (!state) return undefined;
      qualifiers.push(state);
      const reasonWord = this.expectName('parked needs reason "..."');
      if (!reasonWord || reasonWord.name !== "reason" || !this.at("string")) {
        this.error(this.peek().span, 'parked needs reason "..."');
        return undefined;
      }
      const token = this.advance();
      const value: StringExpr = {
        kind: "string",
        span: token.span,
        value: token.value,
      };
      return {
        key,
        qualifiers,
        span: { start: key.span.start, end: value.span.end },
        value,
      };
    }
    if (context === "lifecycle" && key.name === "on") {
      const action = this.parseTemplatedName("on needs an action name");
      if (!action) return undefined;
      qualifiers.push(action);
      if (
        !this.expectPunct(
          ":",
          `on ${action.name} needs : before its source states`,
        )
      ) {
        return undefined;
      }
      while (!this.atPunct("->") && !this.at("eof")) {
        const state = this.parseTemplatedName(
          "expected a source lifecycle state",
        );
        if (!state) return undefined;
        qualifiers.push(state);
        if (this.atPunct("|")) this.advance();
      }
      if (
        !this.expectPunct(
          "->",
          `on ${action.name} needs -> before its target state`,
        )
      ) {
        return undefined;
      }
      const value = this.parseTemplatedName(
        "expected a target lifecycle state",
      );
      return value
        ? {
            key,
            qualifiers,
            span: { start: key.span.start, end: value.span.end },
            value,
          }
        : undefined;
    }
    if (key.name === "notify") {
      const role = this.expectName("notify needs a declared role");
      const via = role
        ? this.expectName("notify needs via before its channel")
        : undefined;
      const channel = via
        ? this.expectName("notify needs a channel")
        : undefined;
      if (!role || via?.name !== "via" || !channel) return undefined;
      qualifiers.push(role, channel);
      return {
        key,
        qualifiers,
        span: { start: key.span.start, end: channel.span.end },
        value: { kind: "boolean", span: channel.span, value: true },
      };
    }
    if (this.atPunct("(")) {
      this.advance();
      while (!this.atPunct(")") && !this.at("eof")) {
        const qualifier = this.at("number")
          ? this.parseIdent()
          : this.expectIdent(`expected a qualifier inside ${key.name}( ... )`);
        if (!qualifier) return undefined;
        qualifiers.push(qualifier);
        if (this.atPunct(",")) this.advance();
      }
      if (!this.expectPunct(")", `${key.name}( ... ) never closes`)) {
        return undefined;
      }
    }

    if (
      (key.name === "requires" || key.name === "computes") &&
      this.isName(this.peek())
    ) {
      while (this.isName(this.peek())) qualifiers.push(this.parseIdent());
    }

    let value: Expr | undefined;
    if (this.atPunct("{")) {
      value = this.parseBlock(
        key.name === "lifecycle" || context === "lifecycle"
          ? "lifecycle"
          : "general",
      );
    } else if (this.atPunct(":")) {
      this.advance();
      value = this.atPunct("{")
        ? this.parseBlock(
            key.name === "lifecycle" || context === "lifecycle"
              ? "lifecycle"
              : "general",
          )
        : this.parseExpr();
    } else if (this.canStartExpr(this.peek())) {
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
    if (token.kind === "keyword") {
      return this.parseIdent();
    }
    if (
      token.kind === "ident" &&
      /^[A-Z]{3}$/.test(token.text) &&
      this.peekAt(1).kind === "number"
    ) {
      const currency = this.parseIdent();
      const amount = this.advance();
      return {
        currency,
        kind: "money",
        raw: amount.value,
        span: { start: currency.span.start, end: amount.span.end },
      };
    }
    if (token.kind === "ident") {
      const ident = this.parseIdent();
      if (ident.name === "true" || ident.name === "false") {
        return {
          kind: "boolean",
          span: ident.span,
          value: ident.name === "true",
        };
      }
      if (ident.name === "decided" && this.atPunct("{")) {
        const body = this.parseBlock();
        if (!body) return undefined;
        return {
          body,
          kind: "decided_amount",
          span: { end: body.span.end, start: ident.span.start },
        };
      }
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
      if (this.atPunct("<")) {
        const args = this.parseAngleArguments();
        if (!args) return undefined;
        return {
          args,
          callee: ident,
          kind: "type_apply",
          span: this.spanFrom(ident.span),
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

  private peekAt(offset: number): Token {
    return this.tokens[
      Math.min(this.index + offset, this.tokens.length - 1)
    ] as Token;
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

  private isName(token: Token): boolean {
    return token.kind === "ident" || token.kind === "keyword";
  }

  private expectName(message: string): IdentExpr | undefined {
    if (this.isName(this.peek())) return this.parseIdent();
    this.error(this.peek().span, message);
    return undefined;
  }

  private parseTemplatedName(message: string): IdentExpr | undefined {
    if (this.atPunct("[")) {
      const open = this.advance();
      const binding = this.expectIdent(
        "an indexed name needs its loop binding",
      );
      if (!binding || !this.expectPunct("]", "an indexed name needs ]")) {
        return undefined;
      }
      const suffix = this.isName(this.peek()) ? this.parseIdent() : undefined;
      return {
        kind: "ident",
        name: `[${binding.name}]${suffix?.name ?? ""}`,
        span: {
          start: open.span.start,
          end: suffix?.span.end ?? this.previous().span.end,
        },
      };
    }
    const base = this.expectName(message);
    if (!base || !this.atPunct("[")) return base;
    this.advance();
    const binding = this.expectIdent("an indexed name needs its loop binding");
    if (!binding || !this.expectPunct("]", "an indexed name needs ]")) {
      return undefined;
    }
    const suffix = this.isName(this.peek()) ? this.parseIdent() : undefined;
    return {
      kind: "ident",
      name: `${base.name}[${binding.name}]${suffix?.name ?? ""}`,
      span: {
        start: base.span.start,
        end: suffix?.span.end ?? this.previous().span.end,
      },
    };
  }

  private canStartExpr(token: Token): boolean {
    return (
      token.kind === "ident" ||
      token.kind === "keyword" ||
      token.kind === "number" ||
      token.kind === "percent" ||
      token.kind === "string" ||
      (token.kind === "punct" && (token.text === "{" || token.text === "["))
    );
  }

  private parsePath(message: string): import("./ast.ts").PathExpr | undefined {
    const first = this.expectName(message);
    if (!first) return undefined;
    const parts = [first];
    while (this.atPunct(".")) {
      this.advance();
      const part = this.expectName("expected a name after .");
      if (!part) return undefined;
      parts.push(part);
    }
    return {
      kind: "path",
      parts,
      span: {
        start: first.span.start,
        end: parts.at(-1)?.span.end ?? first.span.end,
      },
    };
  }

  private parseAngleArguments(): Expr[] | undefined {
    this.advance();
    const args: Expr[] = [];
    while (!this.atPunct(">") && !this.at("eof")) {
      const arg = this.parseExpr();
      if (!arg) return undefined;
      args.push(arg);
      if (this.atPunct(",")) this.advance();
    }
    return this.expectPunct(">", "the type argument list never closes")
      ? args
      : undefined;
  }

  private parseApplication(): ApplyExpr | undefined {
    const callee = this.parsePath("expected an instrument function name");
    if (!callee) return undefined;
    const typeArgs = this.atPunct("<") ? this.parseAngleArguments() : [];
    if (!typeArgs) return undefined;
    if (
      !this.expectPunct(
        "(",
        "an instrument application needs arguments in parentheses",
      )
    ) {
      return undefined;
    }
    const args: Expr[] = [];
    while (!this.atPunct(")") && !this.at("eof")) {
      const arg = this.parseExpr();
      if (!arg) return undefined;
      args.push(arg);
      if (this.atPunct(",")) this.advance();
    }
    if (!this.expectPunct(")", "the instrument argument list never closes")) {
      return undefined;
    }
    return {
      args,
      callee,
      kind: "apply",
      span: { start: callee.span.start, end: this.previous().span.end },
      typeArgs,
    };
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
