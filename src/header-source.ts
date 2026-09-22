import { parseProgram } from "./parse.ts";
import { CompileFailure, fail } from "./diagnostics.ts";

/** Compilation and editor metadata admit the same named header declarations. */
export function parseHeader(source: string, name: string) {
  const parsed = parseProgram(source);
  if (parsed.diagnostics.length)
    throw new CompileFailure({ ...parsed.diagnostics[0]!, source: name });
  const program = parsed.program;
  const locate = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("span" in value) Object.assign(value, { source: name });
    for (const child of Object.values(value)) locate(child);
  };
  locate(program);
  if (!program.header || program.name !== name)
    fail(
      program,
      `${name}: expected header ${name}`,
      `start with header ${name}`,
    );
  const names = new Set<string>();
  for (const decl of program.decls) {
    if (decl.kind !== "instrument") continue;
    if (names.has(decl.name))
      fail(
        decl,
        `duplicate instrument ${name}.${decl.name}`,
        "give each instrument a distinct name",
      );
    names.add(decl.name);
    const parameters = new Set<string>();
    for (const parameter of decl.parameters) {
      if (parameters.has(parameter.key))
        fail(
          parameter,
          `duplicate parameter ${parameter.key}`,
          "declare each parameter once",
        );
      parameters.add(parameter.key);
      const type =
        parameter.value.kind === "default"
          ? parameter.value.type
          : parameter.value;
      if (type.kind === "call" && !["enum", "integer"].includes(type.name))
        fail(
          type,
          `unsupported tunable constructor ${type.name}`,
          "Only enum(choices) and integer(minimum, maximum) are supported tunable constructors. This constructor's restrictions cannot be enforced.",
        );
    }
  }
  return program;
}
