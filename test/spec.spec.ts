import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/index.ts";
import { HSX_IR_VERSION, HSX_VERSION } from "../src/version.ts";
import { validate } from "./json-schema.ts";

const schema = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "spec", "hsx-ir.schema.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
) as { version: string };

const sourcesUnder = (...segments: string[]): readonly string[] => {
  const directory = join(import.meta.dir, "..", ...segments);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".hsx"))
    .map((entry) => join(entry.parentPath, entry.name));
};

describe("spec/hsx-ir.schema.json", () => {
  const compiling = [
    ...sourcesUnder("test", "fixtures"),
    ...sourcesUnder("examples"),
  ];

  it("finds every .hsx source in the tree", () => {
    expect(compiling.length).toBeGreaterThanOrEqual(11);
  });

  for (const path of compiling) {
    const source = readFileSync(path, "utf8");
    const result = compile(source);
    // The diagnostics example is refused on purpose; it has nothing to validate.
    if (!result.artifacts) continue;

    it(`validates the artifacts of ${path.split("/").slice(-2).join("/")}`, () => {
      const errors = validate(schema, {
        document: result.artifacts!.document,
        frame: result.artifacts!.frame,
      });
      expect(errors).toEqual([]);
    });
  }

  it("refuses artifacts the schema does not describe", () => {
    const result = compile(
      readFileSync(sourcesUnder("test", "fixtures")[0]!, "utf8"),
    );
    const tampered = {
      document: { ...result.artifacts!.document, hsx: 2 },
      frame: result.artifacts!.frame,
    };
    expect(validate(schema, tampered)).not.toEqual([]);
  });

  it("throws instead of ignoring a keyword it cannot check", () => {
    expect(() => validate({ multipleOf: 3 }, 9)).toThrow(/unsupported keyword/);
  });
});

describe("versions", () => {
  it("stamps HSX_IR_VERSION into every compiled document", () => {
    for (const path of sourcesUnder("test", "fixtures")) {
      const result = compile(readFileSync(path, "utf8"));
      expect(result.artifacts?.document.hsx).toBe(HSX_IR_VERSION);
    }
  });

  it("keeps HSX_VERSION equal to the package version", () => {
    expect(HSX_VERSION).toBe(manifest.version);
  });
});
