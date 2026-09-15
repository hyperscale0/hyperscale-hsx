import { readFileSync, writeFileSync } from "node:fs";
import { canonicalDigest, serializeUdl } from "@hyperscale0/udl";
import { compile } from "../src/compile.ts";
import type { UdlCostTable } from "../src/cost.ts";
import costTable from "../examples/cost-table.json";

for (const name of ["vocabulary", "attested"]) {
  const source = readFileSync(
    new URL(`../test/fixtures/${name}.hsx`, import.meta.url),
    "utf8",
  );
  const result = compile(source, {
    costTable: costTable as readonly UdlCostTable[],
  });
  if (result.verdict !== "valid" || !result.artifacts)
    throw new Error(`${name}: ${JSON.stringify(result.diagnostics)}`);
  writeFileSync(
    new URL(`../../udl/conformance/valid/${name}.udl`, import.meta.url),
    serializeUdl(result.artifacts.document),
  );
  const expectedPath = new URL(
    `../../udl/conformance/valid/${name}.expected.json`,
    import.meta.url,
  );
  const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  expected.digest = await canonicalDigest(result.artifacts.document);
  writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`);
}
