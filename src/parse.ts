import { lex, type Token } from "./lex.ts";
import type {
  BlockExpr,
  CheckDecl,
  CheckStatement,
  Diagnostic,
  Entry,
  Expr,
  Named,
  Program,
  Span,
} from "./ast.ts";

class ParseFailure extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}
export function parseProgram(source: string): {
  program: Program;
  diagnostics: Diagnostic[];
} {
  const empty: Program = {
    name: "",
    title: "",
    currency: "SAR",
    header: false,
    decls: [],
    checks: [],
    span: { start: 0, end: source.length },
  };
  if (new TextEncoder().encode(source).length > 262144)
    return {
      program: empty,
      diagnostics: [
        {
          code: "HSX1004",
          message: "source exceeds 256 KiB",
          fix: "split the program into headers",
          span: empty.span,
        },
      ],
    };
  if (/^\s*[[{]/.test(source))
    return {
      program: empty,
      diagnostics: [
        {
          code: "HSX1014",
          message: "JSON is not HSX source",
          fix: 'write program name "Title" followed by HSX declarations',
          span: { start: source.search(/\S/), end: source.search(/\S/) + 1 },
        },
      ],
    };
  const result = lex(source);
  if (result.diagnostics.length)
    return { program: empty, diagnostics: result.diagnostics };
  try {
    return {
      program: new Parser(result.tokens).program(empty),
      diagnostics: [],
    };
  } catch (error) {
    if (error instanceof ParseFailure)
      return { program: empty, diagnostics: [error.diagnostic] };
    throw error;
  }
}
/** One value as a header parameter takes it, such as `10%`; undefined if it is not one. */
export function parseExpression(source: string): Expr | undefined {
  const result = lex(source);
  if (result.diagnostics.length) return undefined;
  try {
    return new Parser(result.tokens).value();
  } catch (error) {
    if (error instanceof ParseFailure) return undefined;
    throw error;
  }
}
class Parser {
  private index = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}
  private peek(): Token {
    return this.tokens[this.index]!;
  }
  private take(): Token {
    const token = this.peek();
    if (token.kind !== "eof") this.index++;
    return token;
  }
  private at(text: string): boolean {
    return this.peek().text === text;
  }
  private eat(text: string): boolean {
    if (!this.at(text)) return false;
    this.take();
    return true;
  }
  private fail(message: string, fix: string, span = this.peek().span): never {
    throw new ParseFailure({
      code: "HSX1000",
      message,
      fix,
      span,
    });
  }
  private expect(text: string): void {
    if (!this.eat(text))
      this.fail(
        `expected ${text}, found ${this.peek().text || "end of file"}`,
        `write ${text} here`,
      );
  }
  private identifier(): string {
    if (this.peek().kind !== "name")
      this.fail("expected a name", "write a name starting with a letter");
    return this.take().text;
  }
  private path(): string {
    let name = this.identifier();
    while (this.eat(".")) name += "." + this.identifier();
    return name;
  }
  private separators(): void {
    while (this.eat(",") || this.eat(";")) {}
  }
  private span(start: number): Span {
    return { start, end: this.tokens[Math.max(0, this.index - 1)]!.span.end };
  }
  value(): Expr {
    const value = this.expression();
    if (this.peek().kind !== "eof")
      this.fail("expected one value", "write one value");
    return value;
  }
  program(program: Program): Program {
    if (this.eat("header")) program.header = true;
    else this.expect("program");
    program.name = this.identifier();
    if (!program.header) {
      if (this.peek().kind !== "string")
        this.fail(
          "program needs a title",
          "write a quoted title after its name",
        );
      program.title = JSON.parse(this.take().text) as string;
    }
    let currencyDeclared = false;
    while (this.peek().kind !== "eof") {
      this.separators();
      if (this.peek().kind === "eof") break;
      const start = this.peek().span.start;
      if (this.at("currency")) {
        if (currencyDeclared)
          this.fail(
            "currency is declared twice",
            "keep one currency declaration",
          );
        this.take();
        currencyDeclared = true;
        program.currency = this.identifier();
        continue;
      }
      if (this.eat("party")) {
        const name = this.identifier();
        this.expect(":");
        const partyKind = this.identifier();
        const role = this.eat("role") ? this.identifier() : undefined;
        program.decls.push({
          kind: "party",
          name,
          partyKind,
          ...(role ? { role } : {}),
          span: this.span(start),
        });
        continue;
      }
      if (this.eat("expose")) {
        const target = this.path();
        this.expect("as");
        const name = this.identifier();
        program.decls.push({
          kind: "expose",
          target,
          name,
          span: this.span(start),
        });
        continue;
      }
      if (this.at("check") && this.tokens[this.index + 1]?.kind === "string") {
        program.checks.push(this.check());
        continue;
      }
      if (this.eat("instrument")) {
        const name = this.identifier();
        const parameters = this.eat("(") ? this.entries(")") : [];
        const body = this.block();
        program.decls.push({
          kind: "instrument",
          name,
          parameters,
          body,
          span: this.span(start),
        });
        continue;
      }
      if (this.eat("object")) {
        const name = this.identifier();
        const title =
          this.peek().kind === "string"
            ? (JSON.parse(this.take().text) as string)
            : name;
        const body = this.block();
        program.decls.push({
          kind: "object",
          name,
          title,
          body,
          span: this.span(start),
        });
        continue;
      }
      const name = this.identifier();
      this.expect("=");
      const object = this.path();
      const body = this.block();
      program.decls.push({
        kind: "assignment",
        name,
        target: object,
        body,
        span: this.span(start),
      });
    }
    return program;
  }
  private named(): Named {
    const span = this.peek().span;
    return { name: this.identifier(), span };
  }
  private text(): string {
    if (this.peek().kind !== "string")
      this.fail("expected a quoted name", 'write a name in quotes, as "Alice"');
    return JSON.parse(this.take().text) as string;
  }
  /**
   * `check "Name" { ... }`: customers, steps in order, then `expect`. A step
   * is `clock`, `object`, `close` or `[actor] object.action ... -> state`.
   */
  private check(): CheckDecl {
    const start = this.take().span.start;
    const name = this.text();
    this.expect("{");
    const statements: CheckStatement[] = [];
    while (!this.eat("}")) {
      this.separators();
      if (this.eat("}")) break;
      if (this.peek().kind === "eof")
        this.fail("unclosed check, expected }", "add }");
      const at = this.peek().span.start;
      const statement = this.checkStatement();
      if (statement.kind !== "customer" && this.eat("balances"))
        statement.balances = this.block();
      statement.span = this.span(at);
      statements.push(statement);
      this.separators();
    }
    return { name, statements, span: this.span(start) };
  }
  private checkStatement(): CheckStatement {
    const span = this.peek().span;
    if (this.eat("customer")) {
      const id = this.named();
      const title = this.text();
      const organization = this.eat("organization");
      const fund = this.eat("funded") ? this.atom() : undefined;
      const binds: Named[] = [];
      while (this.eat("binds")) binds.push(this.named());
      return {
        kind: "customer",
        id,
        title,
        organization,
        ...(fund ? { fund } : {}),
        binds,
        span,
      };
    }
    if (this.eat("clock")) {
      const at = this.atom();
      if (!this.eat("until")) return { kind: "clock", at, span };
      const object = this.named();
      const attachment = this.eat(".") ? this.named() : undefined;
      const recordPath = this.eat("record") ? this.path() : undefined;
      this.expect("is");
      const state = this.named();
      return {
        kind: "clock",
        at,
        until: {
          object,
          ...(attachment ? { attachment } : {}),
          ...(recordPath ? { recordPath } : {}),
          state,
        },
        span,
      };
    }
    if (this.eat("object")) {
      const id = this.named();
      this.expect(":");
      const objectKind = this.named();
      if (!this.eat("for"))
        this.fail("an object needs its owner", "write for <customer>");
      const owner = this.named();
      const fields = this.at("{") ? this.block() : undefined;
      return {
        kind: "object",
        id,
        objectKind,
        owner,
        ...(fields ? { fields } : {}),
        span,
      };
    }
    if (this.eat("close"))
      return { kind: "close", customer: this.named(), span };
    if (this.eat("expect")) {
      const statement: Extract<CheckStatement, { kind: "expect" }> = {
        kind: "expect",
        span,
      };
      for (;;) {
        if (this.eat("balances")) statement.balances = this.block();
        else if (this.eat("held")) statement.held = this.atom();
        else if (this.eat("pending")) statement.pending = this.block();
        else break;
      }
      return statement;
    }
    const first = this.named();
    const actor = this.at(".") ? undefined : first;
    const object = actor ? this.named() : first;
    this.expect(".");
    const action = this.named();
    const statement: Extract<CheckStatement, { kind: "action" }> = {
      kind: "action",
      ...(actor ? { actor } : {}),
      object,
      action,
      span,
    };
    if (this.at("{")) statement.input = this.block();
    if (this.eat("fields")) statement.fields = this.block();
    if (this.eat("on")) statement.instance = this.named();
    if (this.eat("remember")) statement.remember = this.named();
    this.expect("->");
    if (this.eat("status")) {
      statement.status = this.atom();
      if (this.peek().kind === "string") statement.code = this.text();
    } else statement.state = this.named();
    return statement;
  }
  private entries(end: string): Entry[] {
    const entries: Entry[] = [];
    while (!this.eat(end)) {
      this.separators();
      if (this.eat(end)) break;
      if (this.peek().kind === "eof")
        this.fail(`unclosed block, expected ${end}`, `add ${end}`);
      const start = this.peek().span.start;
      if (this.eat("attach")) {
        const name = this.identifier();
        this.expect("=");
        const target = this.path();
        const body = this.block();
        entries.push({
          key: `attach ${name} = ${target}`,
          value: body,
          span: this.span(start),
        });
        this.separators();
        continue;
      }
      if (this.eat("rename")) {
        const body = this.block();
        entries.push({
          key: "rename",
          value: body,
          span: this.span(start),
        });
        this.separators();
        continue;
      }
      if (this.eat("expose")) {
        const action = this.identifier();
        // r340: the Architect wrote expose occurrence.pay seven times against
        // a bare "expected a name" and never found the program-level form.
        if (this.at("."))
          this.fail(
            `expose inside an attachment takes one of its own actions, not ${action}.<action>`,
            `delete this line, or expose a caller action of ${action} at program level: expose <object>.<attachment>.${action}.<action> as <name>`,
          );
        let publicName = action;
        if (this.eat("as")) {
          publicName = this.identifier();
        }
        entries.push({
          key: "expose",
          value: {
            kind: "call",
            name: action,
            args: [{ kind: "name", value: publicName, span: this.span(start) }],
            span: this.span(start),
          },
          span: this.span(start),
        });
        this.separators();
        continue;
      }
      let key = this.path();
      if (key === "columns" && !this.at(":")) {
        let value: Expr;
        if (this.at("[")) {
          value = this.atom();
        } else if (this.at("{")) {
          value = this.block();
        } else {
          value = { kind: "list", items: [], span: this.span(start) };
        }
        entries.push({
          key: "columns",
          value,
          span: this.span(start),
        });
        this.separators();
        continue;
      }
      if (key === "checks" && this.at("{")) {
        entries.push({ key, value: this.checks(), span: this.span(start) });
        this.separators();
        continue;
      }
      if (key === "action" && !this.at(":")) key += " " + this.identifier();
      if (key === "economics" && !this.at(":") && !this.at("{"))
        key += " " + this.path();
      if (key === "when") {
        const tunable = this.identifier();
        const relation = this.eat("has") ? "has" : "is";
        if (relation === "is") this.expect("is");
        const choice = this.identifier();
        entries.push({
          key: `when ${tunable} ${relation} ${choice}`,
          value: this.block(),
          span: this.span(start),
        });
        continue;
      }
      const clause = ["requires", "invariants", "moves"].includes(key);
      const value =
        clause && !this.at(":") && !this.at("{")
          ? {
              kind: "list" as const,
              items: [key === "moves" ? this.move() : this.requirement()],
              span: this.span(start),
            }
          : this.at("{")
            ? this.block()
            : (this.expect(":"), this.expression());
      entries.push({ key, value, span: this.span(start) });
      this.separators();
    }
    return entries;
  }
  private node(value: string): Expr {
    return { kind: "text", value, span: this.peek().span };
  }
  private record(values: Record<string, Expr>): BlockExpr {
    const span = this.peek().span;
    return {
      kind: "block",
      entries: Object.entries(values).map(([key, value]) => ({
        key,
        value,
        span: value.span,
      })),
      span,
    };
  }
  private operand(sums = false): BlockExpr {
    const value = this.atom();
    // A header check may add tunables, as in `first + second <= limit`.
    if (sums && this.at("+")) {
      const items = [value];
      while (this.eat("+")) items.push(this.atom());
      return this.record({
        sum: { kind: "list", items, span: this.span(value.span.start) },
      });
    }
    return this.record({
      [value.kind === "name" &&
      /^(self|input|party|subject)\./.test(value.value)
        ? "field"
        : "literal"]: value,
    });
  }
  private operator(): Expr {
    const operator = this.take();
    if (!["==", "!=", "<", "<=", ">", ">="].includes(operator.text))
      this.fail(
        "expected a comparison",
        "write ==, !=, <, <=, >, or >=",
        operator.span,
      );
    return { kind: "text", value: operator.text, span: operator.span };
  }
  /**
   * `checks { late_from < early_until { message: "...", fix: "..." } }`. A rule
   * is a comparison, `x is set` or `x is <its type>`, and `when s is c` scopes it.
   */
  private checks(): BlockExpr {
    const start = this.peek().span.start;
    this.expect("{");
    const entries: Entry[] = [];
    while (!this.eat("}")) {
      this.separators();
      if (this.eat("}")) break;
      if (this.peek().kind === "eof")
        this.fail("unclosed checks, expected }", "add }");
      const at = this.peek().span.start;
      let rule: BlockExpr;
      if (this.tokens[this.index + 1]?.text === "is") {
        const tunable = this.atom();
        this.expect("is");
        rule = this.record({ kind: this.node("is"), tunable, is: this.atom() });
      } else rule = this.requirement(true);
      const values: Record<string, Expr> = {
        rule: { ...rule, span: this.span(at) },
      };
      if (this.eat("when")) {
        const selector = this.atom();
        this.expect("is");
        values.when = this.record({ selector, is: this.atom() });
      }
      values.explain = this.block();
      entries.push({
        key: "check",
        value: { ...this.record(values), span: this.span(at) },
        span: this.span(at),
      });
      this.separators();
    }
    return { kind: "block", entries, span: this.span(start) };
  }
  private requirement(sums = false): BlockExpr {
    if (this.eat("unique")) {
      const namespace = this.atom();
      this.expect("on");
      return this.record({
        kind: this.node("unique"),
        namespace,
        fields: this.atom(),
      });
    }
    if (this.at("count") || this.at("sum")) {
      const measure = this.eat("count")
        ? this.node("count")
        : (this.expect("sum"), this.record({ sum: this.atom() }));
      this.expect("of");
      const selection = this.block();
      const operator = this.operator();
      const value = this.operand();
      return this.record({
        kind: this.node("aggregate"),
        selection,
        measure,
        operator,
        value,
      });
    }
    if (this.eat("hours")) {
      const at = this.atom();
      this.expect("between");
      const start = this.atom();
      this.expect("and");
      const end = this.atom();
      this.expect("timezone");
      return this.record({
        kind: this.node("hours"),
        at,
        start,
        end,
        timezone: this.atom(),
      });
    }
    if (this.eat("evidence")) {
      const subject = this.atom();
      const values: Record<string, Expr> = {
        kind: this.node("evidence"),
        subject,
      };
      for (const key of ["family", "check", "result", "maxAge"]) {
        this.expect(key);
        values[key] = this.atom();
      }
      if (this.eat("instruction")) values.instruction = this.atom();
      return this.record(values);
    }
    const left = this.operand(sums);
    if (this.eat("in")) {
      const reference = left.entries.find(
        (entry) => entry.key === "field",
      )?.value;
      if (!reference)
        this.fail(
          "state requirement needs a reference",
          "write requires self.record in [state]",
        );
      return this.record({
        kind: this.node("state"),
        reference,
        states: this.atom(),
      });
    }
    const operator = this.operator();
    return this.record({
      kind: this.node("compare"),
      left,
      operator,
      right: this.operand(sums),
    });
  }
  private move(): BlockExpr {
    const values: Record<string, Expr> = {};
    if (this.at("post") || this.at("void")) {
      values.operation = this.node("internal_transfer." + this.take().text);
      values.transfer = this.atom();
    } else {
      if (this.eat("reserve"))
        values.operation = this.node("internal_transfer.reserve");
      values.amount = this.atom();
      this.expect("from");
      values.from = this.atom();
      if (this.eat("to")) values.to = this.atom();
      else {
        this.expect("shares");
        values.shares = this.atom();
      }
    }
    for (const key of ["fee", "capture", "key"])
      if (this.eat(key)) values[key] = this.atom();
    if (this.eat("economics")) values.economics = this.block();
    if (this.eat("boundary"))
      values.boundary = this.record({ adapter: this.atom() });
    return this.record(values);
  }
  private block(): BlockExpr {
    const start = this.peek().span.start;
    this.expect("{");
    if (++this.depth > 32)
      this.fail("block nesting exceeds 32", "reduce nested blocks");
    const entries = this.entries("}");
    this.depth--;
    return { kind: "block", entries, span: this.span(start) };
  }
  private expression(): Expr {
    if (++this.depth > 32)
      this.fail("expression nesting exceeds 32", "reduce nested values");
    const start = this.peek().span.start;
    let value = this.atom();
    // `cap:` starts the next entry, so a field may still be named cap.
    if (this.at("cap") && this.tokens[this.index + 1]?.text !== ":") {
      this.take();
      value = {
        kind: "capped",
        rate: value,
        cap: this.atom(),
        span: this.span(start),
      };
    }
    if (this.eat("="))
      value = {
        kind: "default",
        type: value,
        value: this.expression(),
        span: this.span(start),
      };
    this.depth--;
    return value;
  }
  private atom(): Expr {
    const token = this.peek();
    const start = token.span.start;
    if (this.at("{")) return this.block();
    if (this.eat("[")) {
      const items: Expr[] = [];
      while (!this.eat("]")) {
        if (this.peek().kind === "eof") this.fail("unclosed list", "add ]");
        items.push(this.expression());
        this.separators();
      }
      return { kind: "list", items, span: this.span(start) };
    }
    if (token.kind === "number") {
      this.take();
      if (token.text.endsWith("%"))
        return {
          kind: "percent",
          value: token.text.slice(0, -1),
          span: token.span,
        };
      if (/[a-z]$/.test(token.text))
        return { kind: "duration", value: token.text, span: token.span };
      // `1 month` reads as one value, so the checker names the tunable it
      // was given to instead of failing on the next line. A unit followed by
      // `:` is the next entry's key, as in `count: 2` then `months: 2`.
      if (
        /^(?:minute|hour|day|week|month|year)s?$/.test(this.peek().text) &&
        this.peek().kind === "name" &&
        this.tokens[this.index + 1]?.text !== ":"
      ) {
        const unit = this.take().text;
        return {
          kind: "duration",
          value: `${token.text} ${unit}`,
          span: this.span(start),
        };
      }
      if (/^[A-Z]{3}$/.test(this.peek().text)) {
        const currency = this.take().text;
        return {
          kind: "money",
          value: token.text + " " + currency,
          span: this.span(start),
        };
      }
      return { kind: "number", value: token.text, span: token.span };
    }
    if (token.kind === "string" || token.kind === "date") {
      this.take();
      return {
        kind: token.kind === "string" ? "text" : "date",
        value:
          token.kind === "string"
            ? (JSON.parse(token.text) as string)
            : token.text,
        span: token.span,
      };
    }
    const name = this.path();
    if (this.eat("(")) {
      const args: Expr[] = [];
      while (!this.eat(")")) {
        args.push(this.expression());
        this.separators();
      }
      // `integer(1, 366)?` keeps its bounds and may stay unset.
      const optional = this.eat("?");
      return {
        kind: "call",
        name,
        args,
        ...(optional ? { optional } : {}),
        span: this.span(start),
      };
    }
    let target: string | undefined;
    let owner: string | undefined;
    if (["ref", "list"].includes(name) && this.eat("<")) {
      target = this.path();
      this.expect(">");
    }
    const many = name === "ref" && this.eat("[");
    if (many) this.expect("]");
    if (this.eat("of")) owner = this.path();
    const optional = this.eat("?");
    if (target || owner || optional || many)
      return {
        kind: "type",
        name,
        ...(target ? { target } : {}),
        ...(owner ? { owner } : {}),
        optional,
        ...(many ? { many: true } : {}),
        span: this.span(start),
      };
    return { kind: "name", value: name, span: this.span(start) };
  }
}
