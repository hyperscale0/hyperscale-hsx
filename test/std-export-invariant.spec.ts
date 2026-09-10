import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";
import { bundledStandardLibrary } from "../src/std-library.ts";

const moneyFlowsRoot = join(import.meta.dir, "..", "std", "money_flows");

describe("std export invariant", () => {
  const moduleFiles = readdirSync(moneyFlowsRoot)
    .filter((name) => name !== "index.hsx" && name.endsWith(".hsx"))
    .map((name) => name.slice(0, -4))
    .sort();

  test("the retired namespace does not resolve", () => {
    expect(
      bundledStandardLibrary.source("std/settlements", "held_payment"),
    ).toBeUndefined();
  });

  for (const moduleName of moduleFiles) {
    test(`std/money_flows/${moduleName} declares module, exports instrument, and carries reference doc comment`, () => {
      const source = readFileSync(
        join(moneyFlowsRoot, `${moduleName}.hsx`),
        "utf8",
      );
      expect(source).toContain(`module std.money_flows.${moduleName}`);
      expect(source).toContain(`export instrument ${moduleName}`);
      expect(source).toContain("### Purpose");
      expect(source).toContain("### Selection guidance");
      expect(source).toContain("### Parameters");
      expect(source).toContain("### Decision ports");
      expect(source).toContain("### Example");
    });

    test(`std/money_flows/${moduleName} doc comment example compiles cleanly`, () => {
      const source = readFileSync(
        join(moneyFlowsRoot, `${moduleName}.hsx`),
        "utf8",
      );
      const match = source.match(/\/\/\s*```hsx\n([\s\S]*?)\n\/\/\s*```/);
      expect(match).not.toBeNull();
      if (!match?.[1]) throw new Error(`No example found for ${moduleName}`);
      const exampleCode = match[1]
        .split("\n")
        .map((line) => line.replace(/^\/\/\s?/, ""))
        .join("\n");
      const result = compile(exampleCode);
      expect(result.diagnostics).toEqual([]);
      expect(result.verdict).toBe("valid");
      expect(result.artifacts).toBeDefined();
    });
  }
});
