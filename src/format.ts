import { parseProgram } from "./parse.ts";
/** Preserve authored comments and literals; normalize line endings and trailing whitespace. */
export function format(source: string) {
  const parsed = parseProgram(source);
  if (parsed.diagnostics.length)
    return { ok: false as const, diagnostics: parsed.diagnostics };
  return {
    ok: true as const,
    formatted:
      source
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd() + "\n",
  };
}
