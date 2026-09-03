import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeUdl } from "@hyperscale0/udl";
import { describe, expect, it } from "bun:test";
import { compile } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");
const examplesRoot = join(packageRoot, "examples");
const stdRoot = join(packageRoot, "std", "settlements");

function modules(): string[] {
  return readdirSync(stdRoot)
    .filter((file) => file.endsWith(".hsx") && file !== "index.hsx")
    .map((file) => file.slice(0, -4))
    .sort();
}

describe("standard-library examples", () => {
  for (const name of modules()) {
    it(`${name} compiles to its pinned canonical UDL`, () => {
      const directory = join(examplesRoot, name);
      const source = readFileSync(join(directory, `${name}.hsx`), "utf8");
      const pinned = readFileSync(join(directory, `${name}.udl`), "utf8");
      const readme = readFileSync(join(directory, "README.md"), "utf8");
      const result = compile(source, {
        moduleName: `examples/${name}/${name}.hsx`,
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.verdict).toBe("valid");
      expect(result.artifacts).toBeDefined();
      expect(serializeUdl(result.artifacts!.document)).toBe(pinned);
      expect(readme).toContain(`\`${name}\``);
    });
  }

  it("reads the example set from std/settlements", () => {
    for (const name of modules()) {
      expect(readdirSync(join(examplesRoot, name)).sort()).toEqual([
        "README.md",
        `${name}.hsx`,
        `${name}.udl`,
      ]);
    }
  });
});
