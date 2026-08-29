import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/index.ts";

const SOURCE = readFileSync(
  join(import.meta.dir, "fixtures", "derived-amount.hsx"),
  "utf8",
);
const FUNDING_SOURCE = readFileSync(
  join(import.meta.dir, "fixtures", "funding-round.hsx"),
  "utf8",
);

describe("derived_amount", () => {
  it("carries one caller-free percentage rule through HSX IR and UDL", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("missing artifacts");
    const noun = (result.artifacts.document.nouns as Record<string, any>[])[0]!;
    expect(noun.derivedAmounts).toEqual([
      {
        field: "platformAmount",
        rounding: "floor",
        rule: { bps: 250, kind: "percentage_of" },
        sourceField: "transferAmount",
      },
    ]);
    expect(noun.verbs.create.moves).toContainEqual(
      expect.objectContaining({
        amount: "platformAmount",
        from: "payer",
        to: "platform",
      }),
    );
    expect(
      (result.artifacts.frame.moneyEvents as Record<string, any>[]).map(
        (event: any) => event.key,
      ),
    ).toContain("transfer_derived_amount");
  });

  it("refuses fixed and tiered rule syntax", () => {
    for (const rule of ["fixed(100)", "tiered(100)"]) {
      const result = compile(SOURCE.replace("rule: 2.5%", `rule: ${rule}`));
      expect(result.verdict).toBe("invalid");
      expect(
        result.diagnostics.map((item) => item.message).join("\n"),
      ).toContain("percentage-of rules only");
    }
  });

  it("refuses a derived amount whose stored source field is not money", () => {
    const result = compile(
      FUNDING_SOURCE.replace(
        "\n}",
        `
  derived_amount {
    field: platformAmount
    source: closeBy
    rule: 2.5%
    bearer: contributor
  }
}`,
      ),
    );
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics.map((item) => item.message).join("\n")).toContain(
      "non-money field closeBy; from must name a stored money field on the settlement owner",
    );
  });
});
