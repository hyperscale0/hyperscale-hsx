import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
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
    test(`std/money_flows/${moduleName} declares module and exports instrument`, () => {
      const source = readFileSync(
        join(moneyFlowsRoot, `${moduleName}.hsx`),
        "utf8",
      );
      expect(source).toContain(`module std.money_flows.${moduleName}`);
      expect(source).toContain(`export instrument ${moduleName}`);
    });
  }
});
