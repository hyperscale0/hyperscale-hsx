/**
 * The public HSX skill teaches one worked program per settlement
 * brick. Prose drifts silently when a std module renames a field, so every
 * example here is compiled rather than read: the marker set must match the
 * std/settlements modules on disk exactly, and each example must compile with
 * no diagnostic at all, which is stricter than the CLI's `--strict`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";

const referencePath = join(import.meta.dir, "../skills/hsx/SKILL.md");
const settlementsDirectory = join(import.meta.dir, "../std/settlements");

const markerPattern = /^<!--\s*hsx-brick:\s*([a-z_]+)\s*-->$/;

interface ReferenceExample {
  readonly brick: string;
  /** 1-indexed line of the section's marker in the reference. */
  readonly markerLine: number;
  readonly source: string;
}

const reference = readFileSync(referencePath, "utf8");

function readExamples(): readonly ReferenceExample[] {
  const lines = reference.split("\n");
  const markers = lines.flatMap((line, at) => {
    const match = markerPattern.exec(line.trim());
    return match?.[1] ? [{ at, brick: match[1] }] : [];
  });
  return markers.map(({ at, brick }, index) => {
    const limit = markers[index + 1]?.at ?? lines.length;
    const opening = lines.indexOf("```hsx", at + 1);
    if (opening === -1 || opening > limit) {
      throw new Error(`the ${brick} marker is followed by no hsx block`);
    }
    const closing = lines.indexOf("```", opening + 1);
    if (closing === -1 || closing > limit) {
      throw new Error(`the ${brick} hsx block is never closed`);
    }
    return {
      brick,
      markerLine: at + 1,
      source: lines.slice(opening + 1, closing).join("\n"),
    };
  });
}

function settlementModules(): readonly string[] {
  return readdirSync(settlementsDirectory)
    .filter((entry) => entry.endsWith(".hsx") && entry !== "index.hsx")
    .map((entry) => entry.slice(0, -".hsx".length))
    .sort();
}

/**
 * A failure names the section to open, then the compiler's own coordinates.
 * Those stay unmapped on purpose: a diagnostic raised while checking an
 * imported std module carries that module's line, not the example's.
 */
function diagnosticsIn(
  example: ReferenceExample,
  diagnostics: ReturnType<typeof compile>["diagnostics"],
): readonly string[] {
  return diagnostics.map(
    (diagnostic) =>
      `${referencePath}:${example.markerLine} ${example.brick} ` +
      `at ${diagnostic.line}:${diagnostic.column} ${diagnostic.severity} ${diagnostic.stage} ` +
      `${diagnostic.code ?? "uncoded"}: ${diagnostic.message}`,
  );
}

const examples = readExamples();

describe("HSX reference examples", () => {
  test("carries exactly one example per std settlements module", () => {
    const documented = examples.map((example) => example.brick).sort();
    expect(documented).toEqual([...settlementModules()]);
  });

  test("does not pin the standard-library module count in prose", () => {
    const counted = [
      ...reference.matchAll(/\bthe (\d+) settlement (?:bricks|forms)\b/gi),
    ].map((match) => Number(match[1]));
    expect(counted).toEqual([]);
  });

  for (const example of examples) {
    describe(example.brick, () => {
      test("compiles with no diagnostic", () => {
        const result = compile(example.source, { moduleName: referencePath });
        expect(diagnosticsIn(example, result.diagnostics)).toEqual([]);
        expect(result.verdict).toBe("valid");
        expect(result.artifacts?.document).toBeDefined();
      });

      test("imports the brick it documents", () => {
        expect(example.source).toMatch(
          new RegExp(
            `^import \\{[^}]*\\b${example.brick}\\b[^}]*\\} from "std/settlements"$`,
            "m",
          ),
        );
      });
    });
  }
});
