import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { compile } from "./compile.ts";

const sessionsRoot = join(import.meta.dir, "..", "docs", "sessions");

describe("recorded documentation sessions", () => {
  const programs = readdirSync(sessionsRoot)
    .filter((file) => file.endsWith(".hsx"))
    .sort();

  it("records at least one program", () => {
    expect(programs.length).toBeGreaterThan(0);
  });

  for (const file of programs) {
    it(`${file} compiles`, () => {
      const result = compile(readFileSync(join(sessionsRoot, file), "utf8"), {
        moduleName: `docs/sessions/${file}`,
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.verdict).toBe("valid");
    });
  }
});
