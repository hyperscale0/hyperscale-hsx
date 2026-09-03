import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUdl, type UdlDocument } from "@hyperscale0/udl";
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");
const oracleRoot = join(import.meta.dir, "fixtures", "general-path-oracle");

function compileFixture(path: string): UdlDocument {
  const source = readFileSync(join(packageRoot, path), "utf8");
  const result = compile(source, { moduleName: path });
  if (!result.artifacts) {
    throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
  }
  return result.artifacts.document as UdlDocument;
}

function oracle(name: string): UdlDocument {
  return parseUdl(readFileSync(join(oracleRoot, name), "utf8"));
}

function instrument(document: UdlDocument, id: string) {
  const value = document.instruments.find((item) => item.id === id);
  if (!value) throw new Error(`missing instrument ${id}`);
  return value;
}

describe("schedule standard library", () => {
  for (const [path, oracleName] of [
    [
      "test/fixtures/installment-obligation.hsx",
      "test__fixtures__installment-obligation.udl",
    ],
    [
      "test/fixtures/recurring-collection.hsx",
      "test__fixtures__recurring-collection.udl",
    ],
    [
      "test/fixtures/open-membership.hsx",
      "test__fixtures__open-membership.udl",
    ],
  ] as const) {
    test(`${path} matches its complete frozen document`, () => {
      expect(compileFixture(path)).toEqual(oracle(oracleName));
    });
  }

  test("finite schedules unroll byte-contract instrument semantics", () => {
    const path = "test/fixtures/grammar-coverage.hsx";
    expect(instrument(compileFixture(path), "next_season")).toEqual(
      instrument(oracle("test__fixtures__grammar-coverage.udl"), "next_season"),
    );
  });

  test("metered rates construct fields and actions without custody", () => {
    const path = "test/fixtures/insured-travel.hsx";
    const actual = compileFixture(path);
    const expected = oracle("test__fixtures__insured-travel.udl");
    expect(instrument(actual, "package_plan")).toEqual(
      instrument(expected, "package_plan"),
    );
    expect(instrument(actual, "trip_extras")).toEqual(
      instrument(expected, "trip_extras"),
    );
  });

  test("premium forwarding preserves the fee partition and policy actions", () => {
    const path = "test/fixtures/policy-disbursement.hsx";
    const actual = compileFixture(path);
    const expected = oracle("test__fixtures__policy-disbursement.udl");
    expect(instrument(actual, "premium")).toEqual(
      instrument(expected, "premium"),
    );
  });

  test("open recurrence keeps one period liability and drains on cancel", () => {
    const path = "test/fixtures/open-membership.hsx";
    const actual = compileFixture(path);
    const expected = oracle("test__fixtures__open-membership.udl");
    expect(instrument(actual, "membership")).toEqual(
      instrument(expected, "membership"),
    );
  });
});
