import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compile as compileHsx } from "../src/index.ts";
import { hsxDiagnostics } from "../src/diagnostics.ts";
import { compile } from "./compile.ts";

const SOURCE_ROOT = join(import.meta.dir, "..", "src");
const CODE = /HSX\d{4}/g;

function sourceCodes(): string[] {
  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".ts") &&
        entry.name !== "diagnostics.ts" &&
        entry.name !== "std-bundle.ts"
        ? [path]
        : [];
    });

  return sourceFiles(SOURCE_ROOT)
    .flatMap((file) => readFileSync(file, "utf8").match(CODE) ?? [])
    .filter((code, index, codes) => codes.indexOf(code) === index)
    .sort();
}

describe("HSX diagnostic catalog", () => {
  it("matches every diagnostic code literal in the compiler source", () => {
    const catalogCodes = hsxDiagnostics.map(({ code }) => code).sort();

    expect(catalogCodes as string[]).toEqual(sourceCodes());
    expect(new Set(catalogCodes).size).toBe(catalogCodes.length);
  });

  it("raises every source-only example as its first error", () => {
    for (const diagnostic of hsxDiagnostics) {
      if (diagnostic.example === null) continue;
      const result =
        diagnostic.code === "HSX1301"
          ? compileHsx(diagnostic.example)
          : compile(diagnostic.example);
      const firstError = result.diagnostics.find(
        ({ severity }) => severity === "error",
      );

      expect(firstError?.code).toBe(diagnostic.code);
    }
  });

  it("keeps catalog text complete and limits null examples to source-unreachable codes", () => {
    expect(
      hsxDiagnostics
        .filter(({ example }) => example === null)
        .map(({ code }) => code),
    ).toEqual([
      "HSX1005",
      "HSX1006",
      "HSX1009",
      "HSX1015",
      "HSX1016",
      "HSX1017",
      "HSX1020",
      "HSX1021",
      "HSX1022",
      "HSX1302",
      "HSX1303",
      "HSX1601",
      "HSX1602",
    ]);
    for (const diagnostic of hsxDiagnostics) {
      expect(diagnostic.title.trim()).not.toBe("");
      expect(diagnostic.fix.trim()).not.toBe("");
      if (diagnostic.example === null) {
        expect(diagnostic.reason?.trim()).not.toBe("");
      }
    }
  });
});
