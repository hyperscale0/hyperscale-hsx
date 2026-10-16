import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { readExamples } from "../scripts/bundle-examples.ts";

test("every authored example compiles without diagnostics", () => {
  for (const example of readExamples()) {
    const result = compile(example.source);
    if (result.diagnostics.length)
      throw new Error(
        `${example.id}: ${result.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("\n")}`,
      );
    expect(result.verdict).toBe("valid");
  }
});
