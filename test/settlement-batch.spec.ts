import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkProgram, compile, parseProgram } from "../src/index.ts";

type Json = Record<string, any>;

const SOURCE = readFileSync(
  join(import.meta.dir, "fixtures", "settlement-batch.hsx"),
  "utf8",
);

describe("settlement_batch", () => {
  it("checks to mechanism vocabulary", () => {
    const parsed = parseProgram(SOURCE);
    expect(parsed.diagnostics).toEqual([]);
    const checked = checkProgram(parsed.program);
    expect(checked.diagnostics).toEqual([]);
    const settlement = checked.program?.settlements[0];
    expect(settlement).toMatchObject({
      archetype: "settlement_batch",
      closeTriggerField: "closeAt",
      payoutDestination: "payout_destination",
      payoutAcknowledgement: { port: "acknowledge_payout" },
      payoutBeneficiaryReferenceField: "payoutBeneficiaryId",
      settlementAccount: "settlement_account",
      sourceCaptureReferenceField: "captureReference",
    });
    expect(Object.keys(settlement ?? {}).join(" ")).not.toMatch(
      /merchant|biller|chargeback|provider|bank/,
    );
  });

  it("lowers an immutable parent and three lineage entry nouns", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const nouns = result.artifacts.document.nouns as Json[];
    expect(nouns.map((noun) => noun.id)).toEqual([
      "payout_batch",
      "payout_batch_capture_entry",
      "payout_batch_credit_adjustment",
      "payout_batch_debit_adjustment",
    ]);
    const batch = nouns[0]!;
    expect(batch.verbs.close.publicIntent).toBeUndefined();
    expect(batch.verbs.acknowledge_payout.publicIntent).toBe(
      "acknowledgePayoutPayoutBatch",
    );
    expect(
      nouns.slice(1).map((child) => child.verbs.create.publicIntent),
    ).toEqual([
      "createPayoutBatchCaptureEntry",
      "createPayoutBatchCreditAdjustment",
      "createPayoutBatchDebitAdjustment",
    ]);
    expect(batch.verbs.calculate.signedSum).toEqual({
      amountRef: "netPayable",
      onNegative: "refuse",
      onZero: "refuse",
      sources: [
        expect.objectContaining({
          nounId: "payout_batch_capture_entry",
          sign: "add",
          subtotalRef: "grossCaptureAmount",
        }),
        expect.objectContaining({
          nounId: "payout_batch_credit_adjustment",
          sign: "add",
          subtotalRef: "creditAdjustmentAmount",
        }),
        expect.objectContaining({
          nounId: "payout_batch_debit_adjustment",
          sign: "subtract",
          subtotalRef: "debitAdjustmentAmount",
        }),
      ],
    });
    expect(batch.verbs.instruct).not.toHaveProperty("moves");
    expect(batch.verbs.instruct.payout).toEqual({
      amount: "refs.netPayable",
      beneficiaryField: "payoutBeneficiaryId",
      beneficiaryPartyField: "payoutDestinationAccountId",
      capture: "payoutId",
      currencyField: "currency",
      sourceAccountField: "settlementAccountAccountId",
      speed: "standard",
    });
    expect(batch.verbs.acknowledge_payout).toMatchObject({
      captureInput: {
        acknowledgementReference: "acknowledgementReference",
      },
      port: {
        fields: { acknowledgementReference: "text" },
      },
      from: ["instructed"],
      to: "acknowledged",
    });
    expect(batch.verbs.reconcile).toMatchObject({
      from: ["instructed", "acknowledged"],
      requiresSettlement: {
        capture: "settlementEvidenceId",
        payoutRef: "payoutId",
      },
      to: "reconciled",
    });
    expect(batch.verbs.reconcile).not.toHaveProperty("port");
    expect(batch.verbs.reconcile).not.toHaveProperty("input");
    expect(batch.verbs.reconcile).not.toHaveProperty("captureInput");
    expect(batch.fields.payoutBeneficiaryId.type).toBe("beneficiary");
    expect(JSON.stringify(batch.verbs)).not.toMatch(/provider|bank/);
    for (const child of nouns.slice(1)) {
      for (const verb of Object.values(child.verbs) as Json[]) {
        expect(verb.requires).toEqual({
          payoutBatchId: {
            match: { "fields.currency": "fields.currency" },
            statuses: ["open"],
          },
        });
      }
      expect(child.fields.currency.type).toBe("currency");
    }
    expect(nouns[3]!.fields).toMatchObject({
      adjustmentReference: expect.anything(),
      captureReference: expect.anything(),
      externalReversalReference: expect.anything(),
    });
    expect(result.artifacts.frame.moneyEvents).toHaveLength(1);
  });

  it("refuses unsafe negative policy and a malformed acknowledgement", () => {
    const unsafe = compile(
      SOURCE.replace("negative_position: reject", "negative_position: carry"),
    );
    expect(unsafe.verdict).toBe("invalid");
    expect(unsafe.diagnostics.map((item) => item.message).join("\n")).toContain(
      "offsets beyond gross capture entries",
    );
    const missingReference = compile(
      SOURCE.replace("acknowledgementReference: text", "note: text"),
    );
    expect(missingReference.verdict).toBe("invalid");
    expect(
      missingReference.diagnostics.map((item) => item.message).join("\n"),
    ).toContain("needs shape { acknowledgementReference: text }");
    const providerClaim = compile(
      SOURCE.replace("payout_acknowledgement", "provider_confirmation_ref"),
    );
    expect(providerClaim.verdict).toBe("invalid");
    expect(
      providerClaim.diagnostics.map((item) => item.message).join("\n"),
    ).toContain('does not understand "provider_confirmation_ref"');
    const missingBeneficiaryRef = compile(
      SOURCE.replace("  payout_beneficiary_ref: payoutBeneficiaryId\n", ""),
    );
    expect(missingBeneficiaryRef.verdict).toBe("invalid");
    expect(
      missingBeneficiaryRef.diagnostics.map((item) => item.message).join("\n"),
    ).toContain("is missing payout_beneficiary_ref");
  });
});
