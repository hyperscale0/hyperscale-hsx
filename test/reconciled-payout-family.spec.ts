import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UdlDocument } from "@hyperscale0/udl";
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");

function compileFixture(relativePath: string): UdlDocument {
  const source = readFileSync(join(packageRoot, relativePath), "utf8");
  const result = compile(source, { moduleName: relativePath });
  expect(result.diagnostics).toEqual([]);
  if (!result.artifacts) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  return result.artifacts.document as UdlDocument;
}

describe("reconciled payout standard library", () => {
  test("emits external payout instruction, tolerance reconciliation, and companion break instrument", () => {
    const document = compileFixture("test/fixtures/reconciled-payout.hsx");
    expect(document.instruments.map((i) => i.id)).toEqual([
      "supplier_payout",
      "supplier_payout_break",
    ]);

    const payout = document.instruments.find((i) => i.id === "supplier_payout");
    expect(payout).toBeDefined();
    if (!payout) return;

    expect(payout.lifecycle.states).toEqual([
      "created",
      "instructed",
      "settled",
    ]);

    expect(payout.actions.instruct?.payout).toEqual({
      amount: "fields.netPayable",
      beneficiaryField: "supplierBeneficiaryId",
      beneficiaryPartyField: "supplierAccountId",
      capture: "payoutId",
      currencyField: "currency",
      sourceAccountField: "treasuryAccountId",
      speed: "standard",
    });

    expect(payout.actions.settle?.reconcile).toEqual([
      {
        amount: "fields.netPayable",
        capture: "settlementEvidenceId",
        counterpartyRef: "payoutId",
        currencyField: "currency",
        direction: "debit",
        evidence: "statement_line",
        exception: {
          amountField: "unmatchedAmount",
          childInstrumentId: "supplier_payout_break",
          maxOpen: 1,
          reasonField: "breakReason",
          refField: "supplierPayoutId",
        },
        match: {
          dial: "settlement_tolerance",
          law: "tolerance",
          minorUnits: 100,
        },
        within: {
          field: "settleBy",
        },
      },
    ]);

    const payoutBreak = document.instruments.find(
      (i) => i.id === "supplier_payout_break",
    );
    expect(payoutBreak?.lifecycle.states).toEqual(["created", "carried"]);
    expect(Object.keys(payoutBreak?.fields ?? {})).toEqual([
      "unmatchedAmount",
      "currency",
      "breakReason",
      "supplierPayoutId",
    ]);
  });
});
