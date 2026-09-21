import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";
import {
  generateExamplesBundleCode,
  readExamples,
} from "../scripts/bundle-examples.ts";

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

test("the browser example bundle matches the authored files and metadata", () => {
  expect(
    readFileSync(new URL("../src/examples-bundle.ts", import.meta.url), "utf8"),
  ).toBe(generateExamplesBundleCode());
});
