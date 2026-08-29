import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/index.ts";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("obligation-composed bricks", () => {
  it("binds facility draw actors from the locked parent and keeps repayment on the obligation", () => {
    const result = compile(fixture("credit-facility.hsx"));
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("missing artifacts");
    const nouns = result.artifacts.document.nouns as Record<string, any>[];
    const draw = nouns.find((noun) => noun.id === "facility_draw")!;
    expect(draw.verbs.create.requiresExposure[0]).toMatchObject({
      anchorField: "facilityId",
      capField: "facilityLimit",
    });
    expect(draw.verbs.create.requires.facilityId.bind).toEqual({
      currency: "fields.currency",
      drawDestinationAccountId: "fields.drawDestinationAccountId",
      lenderAccountId: "fields.lenderAccountId",
    });
    expect(draw.verbs).not.toHaveProperty("repay");
    expect(
      (result.artifacts.frame.moneyEvents as Record<string, any>[]).filter(
        (event: any) => event.key === "facility_draw",
      ),
    ).toHaveLength(1);
  });

  it("adds mandate evidence to parent repayment without a second noun", () => {
    const result = compile(fixture("recurring-collection.hsx"));
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("missing artifacts");
    const nouns = result.artifacts.document.nouns as Record<string, any>[];
    expect(nouns.some((noun) => noun.id === "collection")).toBe(false);
    const payment = nouns.find(
      (noun) => noun.id === "obligation_installment_1_payment",
    )!;
    expect(payment.verbs.repay.captureInput).toEqual({
      mandateEvidenceReference: "evidenceReference",
    });
    expect(JSON.stringify(payment.verbs)).not.toMatch(/retry/i);
  });

  it("extends premium_forward and gates a capped disbursement with evidence", () => {
    const result = compile(fixture("policy-disbursement.hsx"));
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("missing artifacts");
    const nouns = result.artifacts.document.nouns as Record<string, any>[];
    const premium = nouns.find((noun) => noun.id === "premium")!;
    const approved = nouns.find(
      (noun) => noun.id === "disbursement_approved_amount",
    )!;
    const disbursement = nouns.find((noun) => noun.id === "disbursement")!;
    expect(premium.verbs.endorsement_evidence.captureInput).toEqual({
      endorsementEvidenceReference: "evidenceReference",
    });
    expect(premium.verbs.lapse).not.toHaveProperty("moves");
    expect(approved.verbs.approve.requiresExposure[0].capField).toBe(
      "disbursementCap",
    );
    expect(approved.verbs.create.requires.disbursementId.bind).toEqual({
      currency: "fields.currency",
      destinationAccountId: "fields.destinationAccountId",
      sourceAccountId: "fields.sourceAccountId",
    });
    for (const verb of ["approve", "pay"] as const) {
      expect(approved.verbs[verb].requires.disbursementId).toMatchObject({
        match: {
          "fields.currency": "fields.currency",
          "fields.destinationAccountId": "fields.destinationAccountId",
          "fields.sourceAccountId": "fields.sourceAccountId",
        },
        statuses: ["submitted"],
      });
    }
    expect(disbursement.verbs.deny.requiresAggregate).toEqual([
      expect.objectContaining({
        check: { kind: "all_in" },
        nounId: "disbursement_approved_amount",
        refField: "disbursementId",
        statuses: ["created"],
      }),
    ]);
    expect(approved.verbs.pay.moves[0].amount).toBe("amount");
  });
});
