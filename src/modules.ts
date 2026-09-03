import type { UdlDocument } from "@hyperscale0/udl";
import type {
  ApplicationScopeDecl,
  Decl,
  Expr,
  ImportDecl,
  InstrumentApplyDecl,
  Program,
} from "./ast.ts";
import { lineColIn, lineIndex } from "./ast.ts";
import { parseProgram } from "./parse.ts";
import { bundledStandardLibrary, type StandardLibrary } from "./std-library.ts";

export interface ModuleSource {
  readonly name: string;
  readonly source: string;
}

export interface HsxCompilerHost {
  readonly moduleName?: string;
  /** Published canonical UDL available to `use` declarations. */
  readonly publishedCatalog?: UdlDocument;
  readonly resolveModule?: (
    specifier: string,
    from: string,
  ) => ModuleSource | undefined;
  readonly standardLibrary?: StandardLibrary;
}

export interface ModuleIssue {
  readonly code: string;
  readonly fix: string;
  readonly message: string;
  readonly span: { readonly end: number; readonly start: number };
}

export interface ModuleOrigin {
  readonly column: number;
  readonly line: number;
  readonly moduleName: string;
}

export type ModuleResolution =
  | { readonly issues: readonly ModuleIssue[]; readonly ok: false }
  | {
      readonly ok: true;
      readonly origins: ReadonlyMap<object, ModuleOrigin>;
      readonly program: Program;
    };

const moduleBudget = 64;

export function resolveProgramModules(
  program: Program,
  host: HsxCompilerHost = {},
): ModuleResolution {
  const loaded = new Map<string, Program>();
  const resolving = new Set<string>();
  const seenModules = new Set<string>();
  const issues: ModuleIssue[] = [];
  const origins = new Map<object, ModuleOrigin>();

  const resolveImports = (current: Program, from: string): Program => {
    const appended: Decl[] = [];
    const appendedKeys = new Set<string>();
    const exportSourceByName = new Map<string, string>();
    const imports = current.decls.filter(
      (decl): decl is ImportDecl => decl.kind === "import",
    );
    for (const declaration of imports) {
      const requested = declaration.names.map((name) => name.name);
      const stdLib = host.standardLibrary ?? bundledStandardLibrary;
      const sources = standardSources(
        stdLib,
        declaration.from.value,
        requested,
      );
      const custom =
        sources.length === 0
          ? host.resolveModule?.(declaration.from.value, from)
          : undefined;
      const modules = custom ? [custom] : sources;
      if (modules.length === 0) {
        issues.push({
          code: "HSX1006",
          fix: "correct the module specifier or provide a deterministic module resolver",
          message: `module ${declaration.from.value} cannot be resolved`,
          span: declaration.from.span,
        });
        continue;
      }
      const resolvedNames = new Set<string>();
      for (const module of modules) {
        let moduleProgram = loaded.get(module.name);
        if (!moduleProgram) {
          if (resolving.has(module.name)) {
            issues.push({
              code: "HSX1006",
              fix: "remove the cyclic module import",
              message: `module graph has a cycle through ${module.name}`,
              span: declaration.span,
            });
            continue;
          }
          resolving.add(module.name);
          seenModules.add(module.name);
          if (seenModules.size > moduleBudget) {
            issues.push({
              code: "HSX1006",
              fix: `import no more than ${moduleBudget} modules`,
              message: `the module graph exceeds ${moduleBudget} modules`,
              span: declaration.span,
            });
            resolving.delete(module.name);
            continue;
          }
          const parsed = parseProgram(module.source);
          if (parsed.diagnostics.length > 0) {
            issues.push({
              code: "HSX1006",
              fix: `fix the parse error in module ${module.name}`,
              message: `module ${module.name} does not parse: ${parsed.diagnostics[0]?.message ?? "unknown parse error"}`,
              span: declaration.from.span,
            });
            resolving.delete(module.name);
            continue;
          }
          recordModuleOrigins(parsed.program, module, origins);
          moduleProgram = resolveImports(parsed.program, module.name);
          loaded.set(module.name, moduleProgram);
          resolving.delete(module.name);
        }
        for (const decl of moduleProgram.decls) {
          if (
            (decl.kind !== "instrument" &&
              decl.kind !== "instrument_apply" &&
              decl.kind !== "type" &&
              decl.kind !== "const") ||
            !("exported" in decl) ||
            !decl.exported ||
            !requested.includes(decl.name.name)
          )
            continue;
          resolvedNames.add(decl.name.name);
          const carried =
            decl.kind === "instrument_apply" || decl.kind === "instrument"
              ? withDeclarationScope(decl, moduleProgram)
              : decl;
          const priorSource = exportSourceByName.get(decl.name.name);
          if (priorSource && priorSource !== module.name) {
            issues.push({
              code: "HSX1006",
              fix: "import the name from exactly one module",
              message: `imported name ${decl.name.name} is exported by more than one module`,
              span: declaration.span,
            });
            continue;
          }
          exportSourceByName.set(decl.name.name, module.name);
          const key = `${decl.kind}:${decl.name.name}`;
          if (appendedKeys.has(key)) continue;
          appendedKeys.add(key);
          appended.push(carried);
        }
      }
      for (const name of declaration.names) {
        if (resolvedNames.has(name.name)) continue;
        issues.push({
          code: "HSX1006",
          fix: "import a name that the module exports",
          message: `module ${declaration.from.value} does not export ${name.name}`,
          span: name.span,
        });
      }
    }
    const importerDeclarations = new Map(
      current.decls.flatMap((decl) =>
        decl.kind === "party" || decl.kind === "port"
          ? [[decl.name.name, decl] as const]
          : [],
      ),
    );
    for (const decl of appended) {
      if (
        (decl.kind !== "instrument_apply" && decl.kind !== "instrument") ||
        !decl.declarationScope
      )
        continue;
      for (const local of decl.declarationScope) {
        const importerDeclaration = importerDeclarations.get(local.name.name);
        if (!importerDeclaration) continue;
        if (sameDeclaration(local, importerDeclaration)) continue;
        const importedKind =
          decl.kind === "instrument_apply" ? "application" : "instrument";
        issues.push({
          code: "HSX1009",
          fix: `rename the importer-owned ${local.name.name} declaration`,
          message: `imported ${importedKind} ${decl.name.name} carries module-local ${local.kind} ${local.name.name}, which collides with an importer-owned declaration`,
          span: importerDeclaration.span,
        });
      }
    }
    return { ...current, decls: [...current.decls, ...appended] };
  };

  const resolved = resolveImports(program, host.moduleName ?? "main");
  return issues.length > 0
    ? { issues, ok: false }
    : { ok: true, origins, program: resolved };
}

function recordModuleOrigins(
  program: Program,
  module: ModuleSource,
  origins: Map<object, ModuleOrigin>,
): void {
  const lines = lineIndex(module.source);
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if ("span" in value) {
      const span = value.span;
      if (
        span &&
        typeof span === "object" &&
        "start" in span &&
        typeof span.start === "number"
      ) {
        const position = lineColIn(lines, span.start);
        origins.set(span, {
          column: position.column,
          line: position.line,
          moduleName: module.name,
        });
      }
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(program);
}

function withDeclarationScope(
  application: InstrumentApplyDecl | Extract<Decl, { kind: "instrument" }>,
  moduleProgram: Program,
): InstrumentApplyDecl | Extract<Decl, { kind: "instrument" }> {
  const declarations = new Map<string, ApplicationScopeDecl[]>();
  for (const decl of moduleProgram.decls) {
    if (!isApplicationScopeDecl(decl)) continue;
    const named = declarations.get(decl.name.name) ?? [];
    named.push(decl);
    declarations.set(decl.name.name, named);
    if (decl.kind === "instrument" && decl.declarationScope) {
      for (const local of decl.declarationScope) {
        const localNamed = declarations.get(local.name.name) ?? [];
        localNamed.push(local);
        declarations.set(local.name.name, localNamed);
      }
    }
  }
  const scope: ApplicationScopeDecl[] = [];
  const seen = new Set<ApplicationScopeDecl>();
  const pending: Decl[] = [application];
  while (pending.length > 0) {
    const source = pending.pop();
    if (!source) continue;
    const references = declarationReferences(source);
    for (const name of references.names) {
      for (const declaration of declarations.get(name) ?? []) {
        if (
          (declaration.kind === "party" && !references.parties.has(name)) ||
          (declaration.kind === "port" && !references.ports.has(name))
        )
          continue;
        if (seen.has(declaration)) continue;
        seen.add(declaration);
        scope.push(declaration);
        pending.push(declaration);
      }
    }
  }
  return { ...application, declarationScope: scope };
}

function isApplicationScopeDecl(decl: Decl): decl is ApplicationScopeDecl {
  return (
    decl.kind === "const" ||
    decl.kind === "instrument" ||
    decl.kind === "party" ||
    decl.kind === "port" ||
    decl.kind === "type"
  );
}

function declarationReferences(decl: Decl): {
  readonly names: ReadonlySet<string>;
  readonly parties: ReadonlySet<string>;
  readonly ports: ReadonlySet<string>;
} {
  const names = new Set<string>();
  const parties = new Set<string>();
  const ports = new Set<string>();
  if (decl.kind === "instrument_apply") {
    collectExprNames(decl.application, names, ports);
    for (const argument of decl.application.args) {
      collectApplicationPartyNames(argument, parties);
    }
    if (decl.metadata) collectExprNames(decl.metadata, names, ports);
  }
  if (decl.kind === "instrument") {
    for (const parameter of decl.parameters)
      collectExprNames(parameter.type, names, ports);
    collectExprNames(decl.body, names, ports);
    for (const parameter of [...decl.parameters, ...decl.typeParameters]) {
      names.delete(parameter.name.name);
      parties.delete(parameter.name.name);
      ports.delete(parameter.name.name);
    }
  }
  if (decl.kind === "const") {
    if (decl.type) collectExprNames(decl.type, names, ports);
    collectExprNames(decl.value, names, ports);
  }
  if (decl.kind === "type") collectExprNames(decl.value, names, ports);
  if (decl.kind === "party" && decl.attrs)
    collectExprNames(decl.attrs, names, ports);
  if (decl.kind === "port") collectExprNames(decl.body, names, ports);
  if (decl.kind === "instrument_apply" || isApplicationScopeDecl(decl)) {
    names.delete(decl.name.name);
    parties.delete(decl.name.name);
    ports.delete(decl.name.name);
  }
  return { names, parties, ports };
}

function collectExprNames(
  expr: Expr,
  names: Set<string>,
  ports: Set<string>,
): void {
  if (expr.kind === "ident") names.add(expr.name);
  if (expr.kind === "string") {
    for (const match of expr.value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  if (expr.kind === "money") names.add(expr.currency.name);
  if (expr.kind === "path") {
    for (const part of expr.parts) names.add(part.name);
  }
  if (expr.kind === "type_apply") {
    names.add(expr.callee.name);
    for (const argument of expr.args) collectExprNames(argument, names, ports);
  }
  if (expr.kind === "apply") {
    collectExprNames(expr.callee, names, ports);
    for (const argument of [...expr.typeArgs, ...expr.args]) {
      collectExprNames(argument, names, ports);
    }
  }
  if (expr.kind === "call") {
    names.add(expr.callee.name);
    for (const argument of expr.args) collectExprNames(argument, names, ports);
  }
  if (expr.kind === "binding") collectExprNames(expr.type, names, ports);
  if (expr.kind === "decided_amount") collectExprNames(expr.body, names, ports);
  if (expr.kind === "port_ref") {
    names.add(expr.name.name);
    ports.add(expr.name.name);
  }
  if (expr.kind === "settlement_ref") {
    names.add(expr.owner.name);
    names.add(expr.member.name);
  }
  if (expr.kind === "list") {
    for (const item of expr.items) collectExprNames(item, names, ports);
  }
  if (expr.kind !== "block") return;
  for (const entry of expr.entries) {
    collectTemplatedNameReferences(entry.key.name, names);
    for (const qualifier of entry.qualifiers) {
      collectTemplatedNameReferences(qualifier.name, names);
    }
    if (entry.iteration) collectExprNames(entry.iteration.bound, names, ports);
    collectExprNames(entry.value, names, ports);
    if (entry.iteration) names.delete(entry.iteration.binding.name);
  }
}

function collectApplicationPartyNames(expr: Expr, names: Set<string>): void {
  if (expr.kind === "ident") names.add(expr.name);
  if (expr.kind === "binding") collectApplicationPartyNames(expr.type, names);
  if (expr.kind === "list") {
    for (const item of expr.items) collectApplicationPartyNames(item, names);
  }
}

function sameDeclaration(left: Decl, right: Decl): boolean {
  return (
    left.kind === right.kind &&
    JSON.stringify(canonicalDeclaration(left)) ===
      JSON.stringify(canonicalDeclaration(right))
  );
}

function canonicalDeclaration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDeclaration);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "span" && key !== "declarationScope")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalDeclaration(child)]),
  );
}

function collectTemplatedNameReferences(
  name: string,
  names: Set<string>,
): void {
  for (const match of name.matchAll(/\[([A-Za-z][A-Za-z0-9_]*)\]/g)) {
    if (match[1]) names.add(match[1]);
  }
}

function standardSources(
  standardLibrary: StandardLibrary,
  specifier: string,
  names: readonly string[],
): ModuleSource[] {
  if (specifier !== "std/settlements") return [];
  return names.flatMap((name) => {
    const source = standardLibrary.source(specifier, name);
    return source !== undefined
      ? [
          {
            name: `std.settlements.${name}`,
            source,
          },
        ]
      : [];
  });
}
