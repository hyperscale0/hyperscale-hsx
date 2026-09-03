import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { compile } from "./compile.ts";

const guideRoot = join(import.meta.dir, "..", "docs", "guide");

interface GuideBlock {
  readonly expected?: string;
  readonly file: string;
  readonly line: number;
  readonly source: string;
}

function blocks(): GuideBlock[] {
  return readdirSync(guideRoot)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .flatMap((file) => {
      const markdown = readFileSync(join(guideRoot, file), "utf8");
      return [
        ...markdown.matchAll(
          /^```hsx(?:\s+expect=(HSX\d{4}))?\s*\n([\s\S]*?)^```/gm,
        ),
      ].map((match) => ({
        ...(match[1] ? { expected: match[1] } : {}),
        file,
        line: markdown.slice(0, match.index).split("\n").length,
        source: match[2]?.trim() ?? "",
      }));
    });
}

describe("guide HSX blocks", () => {
  for (const block of blocks()) {
    it(`${block.file}:${block.line}`, () => {
      const result = compile(block.source, {
        moduleName: `docs/guide/${block.file}:${block.line}`,
      });
      const errors = result.diagnostics.filter(
        ({ severity }) => severity === "error",
      );
      if (block.expected) {
        expect(errors.map(({ code }) => code)).toContain(block.expected);
        expect(result.verdict).toBe("invalid");
      } else {
        expect(errors).toEqual([]);
        expect(result.verdict).toBe("valid");
      }
    });
  }

  it("covers every guide chapter", () => {
    const documented = new Set(blocks().map(({ file }) => file));
    expect(documented).toEqual(
      new Set(
        readdirSync(guideRoot)
          .filter((file) => file.endsWith(".md"))
          .sort(),
      ),
    );
  });
});
