import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { compile } from "./compile.ts";
import type { StandardLibrary } from "../src/std-library.ts";

const SRC_ROOT = resolve(import.meta.dir, "../src");

export function stripCommentsAndNonImportStrings(source: string): string {
  // Strip block comments
  let cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments
  cleaned = cleaned.replace(/\/\/.*$/gm, "");

  // Match and strip string literals that are not import specifiers
  const stringRegex = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  cleaned = cleaned.replace(stringRegex, (match, offset, fullText) => {
    const prefix = fullText.slice(0, offset).trimEnd();
    if (
      /\bfrom$/.test(prefix) ||
      /\bimport$/.test(prefix) ||
      /\bimport\s*\($/.test(prefix)
    ) {
      return match;
    }
    return '""';
  });

  return cleaned;
}

export function findNodeImports(content: string): readonly string[] {
  const cleaned = stripCommentsAndNonImportStrings(content);
  const patterns = [
    /\bfrom\s*["'](node:[^"']+)["']/g,
    /\bimport\s*["'](node:[^"']+)["']/g,
    /\bimport\s*\(\s*["'](node:[^"']+)["']\s*\)/g,
  ];
  const matches: string[] = [];
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      if (match[1]) matches.push(match[1]);
    }
  }
  return matches;
}

export function extractRelativeSpecifiers(content: string): readonly string[] {
  const cleaned = stripCommentsAndNonImportStrings(content);
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const relativeSpecifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const specifier = match[1];
      if (
        specifier &&
        (specifier.startsWith("./") || specifier.startsWith("../"))
      ) {
        relativeSpecifiers.push(specifier);
      }
    }
  }
  return relativeSpecifiers;
}

function collectSourceFiles(dir: string): readonly string[] {
  const entries = readdirSync(dir).sort();
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (stat.isFile() && entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("node-free compiler core", () => {
  it("detects the three real node: import forms and ignores comments and strings", () => {
    // 1. from "node:…"
    expect(findNodeImports(`import { readFileSync } from "node:fs";`)).toEqual([
      "node:fs",
    ]);
    expect(findNodeImports(`export { resolve } from "node:path";`)).toEqual([
      "node:path",
    ]);

    // 2. side-effect import "node:…"
    expect(findNodeImports(`import "node:crypto";`)).toEqual(["node:crypto"]);
    expect(findNodeImports(`  import 'node:events';`)).toEqual(["node:events"]);

    // 3. import("node:…")
    expect(findNodeImports(`const os = await import("node:os");`)).toEqual([
      "node:os",
    ]);
    expect(findNodeImports(`const p = import('node:perf_hooks');`)).toEqual([
      "node:perf_hooks",
    ]);

    // Line and block comments mentioning node: must not match
    expect(findNodeImports(`// import { x } from "node:fs";`)).toEqual([]);
    expect(findNodeImports(`// import "node:crypto";`)).toEqual([]);
    expect(findNodeImports(`/* import("node:os"); */`)).toEqual([]);
    expect(
      findNodeImports(
        `/*\n * Comment mentioning node:path and from "node:path"\n */`,
      ),
    ).toEqual([]);

    // String literals mentioning node: must not match
    expect(
      findNodeImports(`const msg = "we do not use node:fs here";`),
    ).toEqual([]);
    expect(
      findNodeImports(`const raw = "import 'node:fs'; from 'node:path'";`),
    ).toEqual([]);
  });

  it("contains no node: specifiers outside src/cli.ts and src/lsp", () => {
    const allFiles = collectSourceFiles(SRC_ROOT);
    const nonCliFiles = allFiles.filter((filePath) => {
      const rel = relative(SRC_ROOT, filePath);
      return (
        rel !== "cli.ts" && !rel.startsWith("lsp/") && !rel.startsWith("lsp\\")
      );
    });

    const violations: string[] = [];
    for (const file of nonCliFiles) {
      const content = readFileSync(file, "utf8");
      const found = findNodeImports(content);
      if (found.length > 0) {
        violations.push(`${relative(SRC_ROOT, file)}: ${found.join(", ")}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("walks the import graph from src/index.ts and reaches zero node: specifiers", () => {
    const entry = join(SRC_ROOT, "index.ts");
    const visited = new Set<string>();
    const queue = [entry];
    const nodeViolations: string[] = [];

    while (queue.length > 0) {
      const currentFile = queue.shift()!;
      if (visited.has(currentFile)) continue;
      visited.add(currentFile);

      const content = readFileSync(currentFile, "utf8");
      const nodeImports = findNodeImports(content);
      if (nodeImports.length > 0) {
        nodeViolations.push(
          `${relative(SRC_ROOT, currentFile)}: ${nodeImports.join(", ")}`,
        );
      }

      const relativeSpecifiers = extractRelativeSpecifiers(content);
      const currentDir = dirname(currentFile);
      for (const specifier of relativeSpecifiers) {
        let resolved = resolve(currentDir, specifier);
        if (!resolved.endsWith(".ts")) {
          resolved += ".ts";
        }
        if (!visited.has(resolved) && !queue.includes(resolved)) {
          queue.push(resolved);
        }
      }
    }

    expect(visited.size).toBeGreaterThan(5);
    expect(nodeViolations).toEqual([]);
  });

  it("permits a custom StandardLibrary host override", () => {
    const customStandardLibrary: StandardLibrary = {
      source(specifier: string, name: string): string | undefined {
        if (specifier === "std/settlements" && name === "custom_witness") {
          return `module std.settlements.custom_witness
export instrument custom_witness {
  title: "Custom";
  fields {}
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}`;
        }
        return undefined;
      },
    };

    const source = `program custom_test "Custom Test"
import { custom_witness } from "std/settlements"
`;

    const result = compile(source, {
      standardLibrary: customStandardLibrary,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
  });
});
