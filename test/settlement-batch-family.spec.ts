import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { serializeUdl } from "@hyperscale0/udl";
import { compile } from "./compile.ts";

test("settlement batch matches its frozen parent and companion bytes", () => {
  const relativePath = "open/hsx/test/fixtures/settlement-batch.hsx";
  const result = compile(
    readFileSync(
      join(import.meta.dir, "fixtures/settlement-batch.hsx"),
      "utf8",
    ),
    { moduleName: relativePath },
  );
  expect(result.diagnostics).toEqual([]);
  if (!result.artifacts) throw new Error("settlement batch did not compile");
  const expected = readFileSync(
    join(
      import.meta.dir,
      "fixtures/general-path-oracle/test__fixtures__settlement-batch.udl",
    ),
    "utf8",
  );
  expect(serializeUdl(result.artifacts.document)).toBe(expected);
});
