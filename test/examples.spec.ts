import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { readHsxDir } from "../scripts/bundle-programs.ts";

test("every authored example compiles without diagnostics", () => {
  for (const example of readHsxDir("examples")) {
    const result = compile(example.source);
    if (result.diagnostics.length)
      throw new Error(
        `${example.id}: ${result.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("\n")}`,
      );
    expect(result.verdict).toBe("valid");
  }
});
