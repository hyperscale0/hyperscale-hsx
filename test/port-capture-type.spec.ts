import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UdlDocument } from "@hyperscale0/udl";
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");

function compileFixture(relativePath: string): UdlDocument {
  const source = readFileSync(join(packageRoot, relativePath), "utf8");
  const result = compile(source, { moduleName: relativePath });
  expect(result.diagnostics).toEqual([]);
  if (!result.artifacts) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  return result.artifacts.document as UdlDocument;
}

describe("decision port capture input typecheck (HSX1026)", () => {
  const publishedCatalog = compileFixture("test/fixtures/captured-payment.hsx");
  const mismatchSource = readFileSync(
    join(packageRoot, "test/fixtures/port-capture-mismatch.hsx"),
    "utf8",
  );

  test("compiles silently without a published catalog", () => {
    const result = compile(mismatchSource);
    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
  });

  test("reports HSX1026 when decision port input type mismatches published instrument capture type", () => {
    const result = compile(mismatchSource, { publishedCatalog });
    expect(result.verdict).toBe("invalid");

    const mismatchDiagnostic = result.diagnostics.find(
      (d) => d.code === "HSX1026",
    );
    expect(mismatchDiagnostic).toBeDefined();
    expect(mismatchDiagnostic).toMatchObject({
      code: "HSX1026",
      fix: "declare externalReference as text in decision port reverse_payment",
      message:
        "decision port reverse_payment field externalReference declares boolean but instrument captured_payment captures it as text",
      severity: "error",
      stage: "typecheck",
    });
  });

  test("accepts a string-backed declared type where the catalog publishes plain text", () => {
    const dateSource = mismatchSource.replace(
      "externalReference: boolean",
      "externalReference: date",
    );
    const result = compile(dateSource, { publishedCatalog });
    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
  });

  test("accepts an instrument reference where the catalog publishes plain text", () => {
    const refSource = mismatchSource.replace(
      "externalReference: boolean",
      "externalReference: id(vehicle)",
    );
    const result = compile(refSource, { publishedCatalog });
    expect(result.diagnostics.filter((d) => d.code === "HSX1026")).toEqual([]);
  });

  test("compiles cleanly with published catalog when decision port field matches captured type", () => {
    const validSource = mismatchSource.replace(
      "externalReference: boolean",
      "externalReference: text",
    );
    const result = compile(validSource, { publishedCatalog });
    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
  });
});
