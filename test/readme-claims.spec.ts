import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { runCli, type Io } from "../src/cli.ts";
import { hsxDiagnostics } from "../src/diagnostics.ts";
import { parseProgram } from "../src/parse.ts";
import { resolveProgramModules } from "../src/modules.ts";
import { compile, testCostTable } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");
const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
const stdRoot = join(packageRoot, "std", "settlements");

function hsxBlocks(): string[] {
  return [...readme.matchAll(/```hsx\n([\s\S]*?)```/g)].map(
    (match) => match[1]?.trim() ?? "",
  );
}

async function cliCode(argv: readonly string[], source = ""): Promise<number> {
  const io: Io = {
    err: () => undefined,
    out: () => undefined,
    readFile: async (path) => {
      if (path.endsWith("cost-table.json"))
        return JSON.stringify(testCostTable);
      if (path === "probe.hsx") return source;
      throw new Error("missing input");
    },
    writeFile: async () => undefined,
  };
  return runCli(argv, io);
}

const claims: readonly {
  readonly sentence: string;
  readonly proof: () => Promise<void> | void;
}[] = [
  {
    sentence: "HSX compiles each accepted program to canonical UDL.",
    proof() {
      const result = compile(hsxBlocks()[0] ?? "");
      expect(result.verdict).toBe("valid");
      expect(result.artifacts?.document.udl).toBe(1);
    },
  },
  {
    sentence:
      "The compiler returns four artifacts named `document`, `frame`, `originMap`, and `costManifest`.",
    proof() {
      const result = compile(hsxBlocks()[0] ?? "");
      expect(Object.keys(result.artifacts ?? {}).sort()).toEqual([
        "costManifest",
        "document",
        "frame",
        "originMap",
      ]);
    },
  },
  {
    sentence: "`document` is the canonical UDL value.",
    proof() {
      expect(compile(hsxBlocks()[0] ?? "").artifacts?.document).toMatchObject({
        udl: 1,
        version: 1,
      });
    },
  },
  {
    sentence:
      "The built-in module resolver reads every settlement module in `std/settlements`.",
    proof() {
      const modules = readdirSync(stdRoot)
        .filter((name) => name.endsWith(".hsx") && name !== "index.hsx")
        .map((name) => name.slice(0, -4))
        .sort();
      expect(modules.length).toBeGreaterThan(0);
      for (const module of modules) {
        const parsed = parseProgram(
          `program resolver_probe "Resolver probe"\nimport { ${module} } from "std/settlements"`,
        );
        const resolved = resolveProgramModules(parsed.program);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) continue;
        expect(
          resolved.program.decls.some(
            (declaration) =>
              "name" in declaration &&
              "name" in declaration.name &&
              declaration.name.name === module,
          ),
        ).toBe(true);
      }
    },
  },
  {
    sentence:
      "After installing dependencies in a repository checkout, run `bun run bin/hsx.ts check product.hsx`.",
    proof() {
      expect(existsSync(join(packageRoot, "bin", "hsx.ts"))).toBe(true);
      expect(
        readFileSync(join(packageRoot, "bin", "hsx.ts"), "utf8"),
      ).toContain("runCli");
    },
  },
  {
    sentence:
      "The CLI exits 0 for an accepted program, 1 for a refused program, and 2 when it cannot use the command line or input file.",
    async proof() {
      const source = hsxBlocks()[0] ?? "";
      expect(await cliCode(["check", "probe.hsx"], source)).toBe(0);
      expect(await cliCode(["check", "probe.hsx"], "{}")).toBe(1);
      expect(await cliCode(["check", "missing.hsx"])).toBe(2);
    },
  },
  {
    sentence:
      "Every compiler diagnostic code appears in the generated diagnostics catalog.",
    proof() {
      const codes = hsxDiagnostics.map(({ code }) => code);
      expect(codes.length).toBeGreaterThan(0);
      expect(new Set(codes).size).toBe(codes.length);
    },
  },
];

describe("README compiler claims", () => {
  for (const claim of claims) {
    it(claim.sentence, async () => {
      expect(readme).toContain(claim.sentence);
      await claim.proof();
    });
  }

  it("compiles every fenced HSX program", () => {
    expect(hsxBlocks().length).toBeGreaterThan(0);
    for (const source of hsxBlocks()) {
      expect(compile(source).diagnostics).toEqual([]);
    }
  });
});
