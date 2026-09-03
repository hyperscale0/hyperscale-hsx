import type { BlockExpr, Decl, Diagnostic, Entry, Expr, Span } from "./ast.ts";
import { lex, type CommentTrivia } from "./lex.ts";
import { parseProgram } from "./parse.ts";

export type FormatResult =
  | { readonly formatted: string; readonly ok: true }
  | { readonly diagnostics: readonly Diagnostic[]; readonly ok: false };

export function format(source: string): FormatResult {
  const parsed = parseProgram(source);
  if (parsed.diagnostics.length > 0) {
    return { diagnostics: parsed.diagnostics, ok: false };
  }

  const context: FormatContext = { comments: lex(source).comments, source };
  return {
    formatted: `${renderSequence(
      parsed.program.decls,
      parsed.program.span,
      0,
      (decl) => renderDecl(decl, context),
      context,
    )}\n`,
    ok: true,
  };
}

interface FormatContext {
  readonly comments: readonly CommentTrivia[];
  readonly source: string;
}

function renderDecl(decl: Decl, context: FormatContext): string {
  switch (decl.kind) {
    case "module":
      return `module ${renderExpr(decl.name, 0, context)};`;
    case "program":
      return `program ${decl.name.name}${decl.title ? ` ${renderExpr(decl.title, 0, context)}` : ""};`;
    case "use":
      return `use ${decl.instrument.name};`;
    case "expose":
      return `expose ${decl.instrument.name}.${decl.action.name} as ${decl.publicName.name};`;
    case "import":
      return `import { ${decl.names.map((name) => name.name).join(", ")} } from ${renderExpr(decl.from, 0, context)};`;
    case "party":
      return renderBlockDecl(
        `party ${decl.name.name}: ${decl.partyKind.name}`,
        decl.attrs,
        context,
      );
    case "asset":
      return renderBlockDecl(
        `asset ${decl.name.name}: ${decl.assetKind.name}`,
        decl.attrs,
        context,
      );
    case "subject":
      return `subject ${decl.name.name} ${renderBlock(decl.body, 0, context)}`;
    case "port":
      return `port ${decl.name.name} ${renderBlock(decl.body, 0, context)}`;
    case "instrument": {
      const exported = decl.exported ? "export " : "";
      const typeParameters =
        decl.typeParameters.length > 0
          ? `<${decl.typeParameters.map((parameter) => parameter.name.name).join(", ")}>`
          : "";
      const parameters = decl.hasParameterList
        ? `(${decl.parameters
            .map(
              (parameter) =>
                `${parameter.name.name}: ${renderExpr(parameter.type, 0)}`,
            )
            .join(", ")})`
        : "";
      return `${exported}instrument ${decl.name.name}${typeParameters}${parameters} ${renderBlock(decl.body, 0, context)}`;
    }
    case "instrument_apply":
      return `${decl.exported ? "export " : ""}instrument ${decl.name.name} = ${renderExpr(decl.application, 0, context)}${decl.metadata ? ` ${renderBlock(decl.metadata, 0, context)}` : ";"}`;
    case "type":
      return `${decl.exported ? "export " : ""}type ${decl.name.name} = ${renderExpr(decl.value, 0, context)};`;
    case "const": {
      const type = decl.type ? `: ${renderExpr(decl.type, 0, context)}` : "";
      return `${decl.exported ? "export " : ""}const ${decl.name.name}${type} = ${renderExpr(decl.value, 0, context)};`;
    }
  }
}

function renderBlockDecl(
  header: string,
  body: BlockExpr | undefined,
  context: FormatContext,
): string {
  return body ? `${header} ${renderBlock(body, 0, context)}` : `${header};`;
}

function renderBlock(
  block: BlockExpr,
  indent: number,
  context: FormatContext,
): string {
  const rows = renderSequence(
    block.entries,
    block.span,
    indent + 1,
    (entry) =>
      `${spaces(indent + 1)}${renderEntry(entry, indent + 1, context)}`,
    context,
  );
  if (rows.length === 0) return "{}";
  return `{\n${rows}\n${spaces(indent)}}`;
}

function renderEntry(
  entry: Entry,
  indent: number,
  context: FormatContext,
): string {
  const key = entry.key.name;
  const identifierKey =
    /^[A-Za-z][A-Za-z0-9_]*(?:\[[A-Za-z][A-Za-z0-9_]*\][A-Za-z0-9_]*)?$/.test(
      key,
    );
  const renderedKey =
    !entry.key.quoted && identifierKey ? key : JSON.stringify(key);
  if (entry.iteration && entry.value.kind === "block") {
    return `for ${entry.iteration.binding.name} in ${renderExpr(entry.iteration.bound, indent, context)} ${renderBlock(entry.value, indent, context)}`;
  }
  if (key === "action" && entry.value.kind === "block") {
    return `action ${entry.qualifiers[0]?.name ?? ""} ${renderBlock(entry.value, indent, context)}`;
  }
  if (key === "states" && entry.value.kind === "list") {
    return `states ${entry.value.items.map((item) => renderExpr(item, indent, context)).join(" ")};`;
  }
  if (key === "initial") {
    return `initial ${renderExpr(entry.value, indent, context)};`;
  }
  if (key === "parked") {
    return `parked ${entry.qualifiers[0]?.name ?? ""} reason ${renderExpr(entry.value, indent, context)};`;
  }
  if (key === "on") {
    const [action, ...states] = entry.qualifiers;
    return `on ${action?.name ?? ""}: ${states.map((state) => state.name).join(" | ")} -> ${renderExpr(entry.value, indent, context)};`;
  }
  if (key === "notify") {
    return `notify ${entry.qualifiers[0]?.name ?? ""} via ${entry.qualifiers[1]?.name ?? ""};`;
  }

  const qualifier = renderQualifier(key, entry);
  if (entry.value.kind === "block") {
    return `${renderedKey}${qualifier} ${renderBlock(entry.value, indent, context)}`;
  }
  return `${renderedKey}${qualifier}: ${renderExpr(entry.value, indent, context)};`;
}

function renderQualifier(key: string, entry: Entry): string {
  if (entry.qualifiers.length === 0) return "";
  const names = entry.qualifiers.map((qualifier) => qualifier.name);
  return key === "requires" || key === "computes"
    ? ` ${names.join(" ")}`
    : `(${names.join(", ")})`;
}

function renderExpr(
  expr: Expr,
  indent: number,
  context?: FormatContext,
): string {
  switch (expr.kind) {
    case "ident":
      return expr.name;
    case "string":
      return `"${expr.value}"`;
    case "number":
      return expr.raw;
    case "boolean":
      return String(expr.value);
    case "money":
      return `${expr.currency.name} ${expr.raw}`;
    case "percent":
      return `${expr.raw}%`;
    case "path":
      return expr.parts.map((part) => part.name).join(".");
    case "settlement_ref":
      return `${expr.owner.name}.${expr.member.name}`;
    case "type_apply":
      return `${expr.callee.name}<${expr.args.map((arg) => renderExpr(arg, indent, context)).join(", ")}>`;
    case "call":
      return `${expr.callee.name}(${expr.args.map((arg) => renderExpr(arg, indent, context)).join(", ")})`;
    case "apply": {
      const typeArgs =
        expr.typeArgs.length > 0
          ? `<${expr.typeArgs.map((arg) => renderExpr(arg, indent, context)).join(", ")}>`
          : "";
      return `${renderExpr(expr.callee, indent, context)}${typeArgs}(${expr.args
        .map((arg) => renderExpr(arg, indent, context))
        .join(", ")})`;
    }
    case "binding":
      return `${expr.name.name}: ${renderExpr(expr.type, indent, context)}`;
    case "list":
      return `[${expr.items.map((item) => renderExpr(item, indent, context)).join(", ")}]`;
    case "block":
      return renderBlock(expr, indent, context as FormatContext);
    case "decided_amount":
      return `decided ${renderBlock(expr.body, indent, context as FormatContext)}`;
    case "port_ref": {
      const within = expr.within ? ` within ${expr.within.name}` : "";
      const deadline = expr.deadline ? ` | at(${expr.deadline.name})` : "";
      return `port ${expr.name.name}${within}${deadline}`;
    }
  }
}

function renderSequence<T extends { readonly span: Span }>(
  children: readonly T[],
  container: Span,
  indent: number,
  render: (child: T) => string,
  context: FormatContext,
): string {
  const rows: string[] = [];
  let cursor = container.start;
  for (const child of children) {
    appendComments(rows, cursor, child.span.start, indent, context);
    rows.push(render(child));
    cursor = child.span.end;
  }
  appendComments(rows, cursor, container.end, indent, context);
  return rows.join("\n");
}

function appendComments(
  rows: string[],
  start: number,
  end: number,
  indent: number,
  context: FormatContext,
): void {
  for (const comment of context.comments) {
    if (comment.span.start < start || comment.span.end > end) continue;
    const trailing =
      rows.length > 0 &&
      !context.source.slice(start, comment.span.start).includes("\n");
    if (trailing) {
      const last = rows.pop() as string;
      const newline = last.lastIndexOf("\n");
      rows.push(
        newline < 0
          ? `${last} ${comment.text}`
          : `${last.slice(0, newline + 1)}${last.slice(newline + 1)} ${comment.text}`,
      );
    } else {
      rows.push(`${spaces(indent)}${comment.text}`);
    }
    start = comment.span.end;
  }
}

function spaces(indent: number): string {
  return "  ".repeat(indent);
}
