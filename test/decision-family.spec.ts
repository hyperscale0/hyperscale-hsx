import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");
const oracleRoot = join(import.meta.dir, "fixtures", "general-path-oracle");

function oracleName(relativePath: string): string {
  return `${relativePath.replace(/\.hsx$/, "").replaceAll("/", "__")}.udl`;
}

function familyInstruments(relativePath: string, ids: readonly string[]) {
  const result = compile(
    readFileSync(join(packageRoot, relativePath), "utf8"),
    { moduleName: relativePath },
  );
  if (!result.artifacts) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  const document = result.artifacts.document as {
    readonly instruments: readonly { readonly id: string }[];
  };
  return document.instruments.filter((instrument) =>
    ids.includes(instrument.id),
  );
}

function oracleInstruments(relativePath: string, ids: readonly string[]) {
  const document = JSON.parse(
    readFileSync(join(oracleRoot, oracleName(relativePath)), "utf8"),
  ) as { readonly instruments: readonly { readonly id: string }[] };
  return document.instruments.filter((instrument) =>
    ids.includes(instrument.id),
  );
}

describe("decision and credit settlement family", () => {
  const cases = [
    {
      ids: ["disbursement", "disbursement_approved_amount"],
      path: "test/fixtures/policy-disbursement.hsx",
    },
    {
      ids: ["agency_advance"],
      path: "test/fixtures/insured-travel.hsx",
    },
    {
      ids: ["financing"],
      path: "test/fixtures/financed-retention.hsx",
    },
    {
      ids: ["facility", "facility_draw"],
      path: "test/fixtures/credit-facility.hsx",
    },
  ] as const;

  for (const witness of cases) {
    test(`${witness.path} matches its frozen family instruments`, () => {
      expect(familyInstruments(witness.path, witness.ids)).toEqual(
        oracleInstruments(witness.path, witness.ids),
      );
    });
  }
});
