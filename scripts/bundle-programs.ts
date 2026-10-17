import { readdirSync, readFileSync } from "node:fs";
import { parseProgram } from "../src/parse.ts";
import { namedHeaders } from "../src/headers.ts";
import { scan } from "../src/lex.ts";
import type { HsxBase } from "../src/bases.ts";

// Each directory's bundle type and the summary its programs open with.
const directories = {
  bases: { type: "HsxBase", summary: "mechanism" },
  examples: { type: "HsxExample", summary: "business" },
} as const;

type Directory = keyof typeof directories;

export function readHsxDir(dir: Directory): HsxBase[] {
  const directory = new URL(`../${dir}/`, import.meta.url);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".hsx"))
    .sort()
    .map((name) => {
      const source = readFileSync(new URL(name, directory), "utf8");
      const parsed = parseProgram(source);
      if (
        parsed.diagnostics.length ||
        parsed.program.header ||
        !parsed.program.title
      )
        throw new Error(
          `${name}: expected a program with a display title; ${parsed.diagnostics.map((d) => d.message).join("; ")}`,
        );
      const comments: string[] = [];
      for (const token of scan(source).tokens) {
        if (token.kind !== "comment") break;
        comments.push(token.text.slice(2).trim());
      }
      const summary = comments.join(" ");
      if (!summary)
        throw new Error(
          `${name}: start with a // ${directories[dir].summary} summary`,
        );
      return {
        id: name.slice(0, -4),
        title: parsed.program.title,
        summary,
        headers: namedHeaders(source),
        source,
      };
    });
}

export function generateProgramsBundleCode(dir: Directory): string {
  const { type } = directories[dir];
  return [
    `import type { ${type} } from "./${dir}.ts";`,
    `export const ${dir}: ${type}[] = [`,
    ...readHsxDir(dir).map((program) => `  ${JSON.stringify(program)},`),
    "];",
    "",
  ].join("\n");
}
