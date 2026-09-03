import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UdlDocument } from "@hyperscale0/udl";
import { serializeUdl } from "@hyperscale0/udl";
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");
const oracleRoot = join(import.meta.dir, "fixtures", "general-path-oracle");

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

describe("swap standard library", () => {
  test("comic swap matches its complete frozen document byte for byte", () => {
    const relativePath = "open/hsx/test/fixtures/comic-swap.hsx";
    const actual = compileSource(
      readFileSync(
        join(packageRoot, relativePath.replace(/^open\/hsx\//, "")),
        "utf8",
      ),
      relativePath,
    );
    const expectedBytes = readFileSync(
      join(oracleRoot, "test__fixtures__comic-swap.udl"),
      "utf8",
    );

    expect(serializeUdl(actual)).toBe(expectedBytes);
  });

  test("watch club swap matches its frozen instrument", () => {
    const actual = compileSource(
      `program watch_club "Watch club"
import { swap } from "std/settlements"
party member: person
party seller: business
settlement member_trade = swap {
  between: [member, seller]
  amounts {
    member: memberPays: money(SAR)
    seller: sellerPays: money(SAR)
  }
  fees {
    member: memberTradeFee: money(SAR)
    seller: sellerTradeFee: money(SAR)
  }
  release: port confirm_trade
  dispute: port resolve_trade within P14D
}
port confirm_trade { allowed: [member, seller] }
port resolve_trade { allowed: [member, seller] }
`,
      "watch-club-swap-r4",
    ).instruments.find((instrument) => instrument.id === "member_trade");
    const expected = oracle(
      "examples__05-watch-club__watch-club.udl",
    ).instruments.find((instrument) => instrument.id === "member_trade");

    expect(actual).toEqual(expected);
  });
});
