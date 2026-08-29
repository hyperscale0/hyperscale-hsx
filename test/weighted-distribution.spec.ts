import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkProgram, compile, parseProgram } from "../src/index.ts";

type Json = Record<string, any>;

const SOURCE = readFileSync(
  join(import.meta.dir, "fixtures", "weighted-distribution.hsx"),
  "utf8",
);

describe("weighted_distribution", () => {
  it("checks to an evidence-backed largest-remainder mechanism", () => {
    const parsed = parseProgram(SOURCE);
    expect(parsed.diagnostics).toEqual([]);
    const checked = checkProgram(parsed.program);
    expect(checked.diagnostics).toEqual([]);
    const settlement = checked.program?.settlements[0];
    expect(settlement).toMatchObject({
      amount: { currency: "SAR", name: "distributableAmount" },
      archetype: "weighted_distribution",
      correctionPolicy: "new_distribution",
      maxRecipients: 12,
      recipient: "recipient",
      recordAtField: "recordAt",
      roundingPolicy: "largest_remainder",
      snapshot: { port: "snapshot_entitlements" },
      source: "distribution_source",
      weight: { currency: "SAR", name: "entitlementWeight" },
      withholdingPolicy: "refuse",
    });
    expect(Object.keys(settlement ?? {}).join(" ")).not.toMatch(
      /merchant|insurance|profit|impairment|sharia|withholdAmount/,
    );
  });

  it("lowers one frozen parent and repeatable entitlement rows", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const nouns = result.artifacts.document.nouns as Json[];
    expect(nouns.map((noun) => noun.id)).toEqual([
      "proceeds",
      "proceeds_entitlement",
    ]);

    const [distribution, entitlement] = nouns;
    expect(distribution).toMatchObject({
      aggregateInvariants: [
        {
          childNounId: "proceeds_entitlement",
          childRefField: "proceedsId",
          childStatuses: ["recorded", "paid"],
          count: true,
          parentField: "maxRecipients",
        },
      ],
      fields: {
        distributableAmount: expect.objectContaining({ type: "money" }),
        recordAt: expect.objectContaining({ type: "date" }),
        maxRecipients: expect.objectContaining({ type: "const:12" }),
      },
    });
    expect(distribution!.verbs.snapshot_entitlements).toMatchObject({
      captureInput: { snapshotEvidenceReference: "evidenceReference" },
      from: ["open"],
      port: {
        fields: { evidenceReference: "text" },
      },
      to: "snapshotted",
    });

    expect(entitlement!.fields).toMatchObject({
      currency: expect.objectContaining({ type: "currency" }),
      entitlementWeight: expect.objectContaining({ type: "money" }),
      proceedsId: expect.objectContaining({ type: "ref:proceeds" }),
    });
    expect(entitlement!.verbs.create.requires).toEqual({
      proceedsId: {
        bind: {
          currency: "fields.currency",
          distributionSourceAccountId: "fields.distributionSourceAccountId",
        },
        statuses: ["open"],
      },
    });
    expect(entitlement!.verbs.payout).toMatchObject({
      distribute: {
        amountRef: "payoutShare",
        onZero: "skip_steps",
        pool: { from: "parent", path: "fields.distributableAmount" },
        refField: "proceedsId",
        statuses: ["recorded", "paid"],
        weightField: "entitlementWeight",
      },
      from: ["recorded"],
      moves: [
        expect.objectContaining({
          amount: "refs.payoutShare",
          from: "distribution_source",
          operation: "create",
          to: "recipient",
        }),
      ],
      requires: {
        proceedsId: {
          match: {
            "fields.currency": "fields.currency",
            "fields.distributionSourceAccountId":
              "fields.distributionSourceAccountId",
          },
          statuses: ["snapshotted"],
        },
      },
      to: "paid",
    });
    const events = result.artifacts.frame.moneyEvents as Json[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      key: "proceeds_payout",
      occurrence: "repeatable",
    });
  });

  it("refuses withholding and inline correction money", () => {
    const withholding = compile(
      SOURCE.replace(
        "withholding_policy: refuse",
        "withholding_policy: retain",
      ),
    );
    expect(withholding.verdict).toBe("invalid");
    expect(
      withholding.diagnostics.map((item) => item.message).join("\n"),
    ).toContain("withholding needs its own proved retained-amount mechanism");

    const inlineCorrection = compile(
      SOURCE.replace(
        "correction_policy: new_distribution",
        "correction_policy: inline",
      ),
    );
    expect(inlineCorrection.verdict).toBe("invalid");
    expect(
      inlineCorrection.diagnostics.map((item) => item.message).join("\n"),
    ).toContain("post-payout correction is a new linked distribution");
  });

  it("requires stored evidence and one currency for amount and weight", () => {
    const missingEvidence = compile(
      SOURCE.replace(
        "shape: { evidenceReference: text }",
        "shape: { note: text }",
      ),
    );
    expect(missingEvidence.verdict).toBe("invalid");
    expect(
      missingEvidence.diagnostics.map((item) => item.message).join("\n"),
    ).toContain("needs shape { evidenceReference: text }");

    const currencyMismatch = compile(
      SOURCE.replace(
        "entitlementWeight: money(SAR)",
        "entitlementWeight: money(USD)",
      ),
    );
    expect(currencyMismatch.verdict).toBe("invalid");
    expect(
      currencyMismatch.diagnostics.map((item) => item.message).join("\n"),
    ).toContain("pool and stored weights need one denomination");
  });
});
