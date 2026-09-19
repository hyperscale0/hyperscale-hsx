import { lex, type Token } from "./lex.ts";
import type {
  BlockExpr,
  Diagnostic,
  Entry,
  Expr,
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
  private fail(message: string, fix: string): never {
    throw new ParseFailure({
      code: "HSX1000",
      message,
      fix,
      span: this.peek().span,
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
    while (this.peek().kind !== "eof") {
      this.separators();
      if (this.peek().kind === "eof") break;
      const start = this.peek().span.start;
      if (this.eat("currency")) {
        program.currency = this.identifier();
        continue;
      }
      if (this.eat("use")) {
        program.decls.push({
          kind: "use",
          name: this.identifier(),
          span: this.span(start),
        });
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
      if (this.at("expose") || this.at("hide")) {
        const kind = this.take().text as "expose" | "hide";
        const target = this.path();
        let name: string | undefined;
        if (kind === "expose") {
          this.expect("as");
          name = this.identifier();
        }
        program.decls.push(
          kind === "expose"
            ? { kind, target, name: name!, span: this.span(start) }
            : { kind, target, span: this.span(start) },
        );
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
      const name = this.identifier();
      this.expect("=");
      const object = this.path();
      const body = this.block();
      program.decls.push({
        kind: "object",
        name,
        object,
        body,
        span: this.span(start),
      });
    }
    return program;
  }
  private entries(end: string): Entry[] {
    const entries: Entry[] = [];
    while (!this.eat(end)) {
      this.separators();
      if (this.eat(end)) break;
      if (this.peek().kind === "eof")
        this.fail(`unclosed block, expected ${end}`, `add ${end}`);
      const start = this.peek().span.start;
      let key = this.path();
      if (key === "action" && !this.at(":")) key += " " + this.identifier();
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
  private operand(): BlockExpr {
    const value = this.atom();
    return this.record({
      [value.kind === "name" && /^(self|input|party)\./.test(value.value)
        ? "field"
        : "literal"]: value,
    });
  }
  private operator(): Expr {
    const operator = this.take();
    if (!["==", "!=", "<", "<=", ">", ">="].includes(operator.text))
      this.fail("expected a comparison", "write ==, !=, <, <=, >, or >=");
    return this.node(operator.text);
  }
  private requirement(): BlockExpr {
    if (this.eat("approval")) {
      this.expect("by");
      const party = this.atom();
      const values: Record<string, Expr> = {
        kind: this.node("approval"),
        party,
        decision: this.node("approved"),
      };
      if (this.eat("for")) values.action = this.atom();
      if (this.eat("is")) values.decision = this.atom();
      return this.record(values);
    }
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
      return this.record(values);
    }
    const left = this.operand();
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
      right: this.operand(),
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
    if (this.eat("cap"))
      value = {
        kind: "capped",
        rate: value,
        cap: this.atom(),
        span: this.span(start),
      };
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
      return { kind: "call", name, args, span: this.span(start) };
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
