import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UdlDocument } from "@hyperscale0/udl";
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");
const oracleRoot = join(import.meta.dir, "fixtures", "general-path-oracle");

function compileDocument(relativePath: string): UdlDocument {
  return compileSource(
    readFileSync(
      join(packageRoot, relativePath.replace(/^open\/hsx\//, "")),
      "utf8",
    ),
    relativePath,
  );
}

function compileSource(source: string, moduleName: string): UdlDocument {
  const result = compile(source, { moduleName });
  expect(result.diagnostics).toEqual([]);
  if (!result.artifacts) throw new Error(`${moduleName} did not compile`);
  return result.artifacts.document as unknown as UdlDocument;
}

function oracle(name: string): UdlDocument {
  return JSON.parse(
    readFileSync(join(oracleRoot, name), "utf8"),
  ) as UdlDocument;
}

describe("distribution standard library", () => {
  test("weighted distribution emits its parent and entitlement bytes", () => {
    const actual = compileDocument(
      "open/hsx/test/fixtures/weighted-distribution.hsx",
    );
    const expected = oracle("test__fixtures__weighted-distribution.udl");
    expect(actual).toEqual(expected);
  });

  test("funding round emits its parent and commitment bytes", () => {
    const actual = compileDocument("open/hsx/test/fixtures/funding-round.hsx");
    const expected = oracle("test__fixtures__funding-round.udl");
    expect(actual).toEqual(expected);
  });

  test("pooled split emits tutor_payout exactly", () => {
    const actual = compileDocument(
      "open/hsx/examples/04-complete-product/study-hall.hsx",
    ).instruments.find((instrument) => instrument.id === "tutor_payout");
    const expected = oracle(
      "examples__04-complete-product__study-hall.udl",
    ).instruments.find((instrument) => instrument.id === "tutor_payout");
    expect(actual).toEqual(expected);
  });

  test("pooled split emits fulfillment_pool exactly", () => {
    const actual = compileSource(
      `program commerce_escrow "Commerce cooperative"
import { pooled_split } from "std/settlements"
party merchant: business
party courier: business
party packer: business
settlement fulfillment_pool = pooled_split {
  payer: merchant
  amount: poolTotal: money(SAR)
  payout_due: payoutDate
  split { courier: 60%, packer: 40%, remainder_to: courier }
}`,
      "pooled-split-fulfillment-test",
    ).instruments[0];
    const expected = oracle(
      "test__fixtures__commerce-escrow.udl",
    ).instruments.find((instrument) => instrument.id === "fulfillment_pool");
    expect(actual).toEqual(expected);
  });
});
