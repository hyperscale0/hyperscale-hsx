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

describe("held payment standard library family", () => {
  test("dispute freezes: transitions funded hold to disputed without moving money, preserving escrow balance", () => {
    const multiPieceDoc = compileFixture("test/fixtures/car-escrow.hsx");
    const multiPieceSale = multiPieceDoc.instruments.find(
      (instrument) => instrument.id === "sale",
    );
    expect(multiPieceSale).toBeDefined();
    if (!multiPieceSale) return;

    expect(multiPieceSale.lifecycle.states).toContain("disputed");
    expect(multiPieceSale.lifecycle.transitions.dispute).toEqual({
      from: ["funded"],
      to: "disputed",
    });
    expect(multiPieceSale.actions.dispute?.moves).toEqual([]);
    expect(multiPieceSale.actions.dispute?.steps).toEqual([]);
    expect(multiPieceSale.actions.dispute?.agentDescription).toContain(
      "Freeze a funded sale so neither release nor refund can run",
    );
    expect(multiPieceSale.actions.dispute?.description).toContain(
      "Freezes funded sale, preserving the entire balance",
    );

    const wholeDoc = compileFixture("test/fixtures/whole-held-payment.hsx");
    const wholeHold = wholeDoc.instruments.find(
      (instrument) => instrument.id === "custody_hold",
    );
    expect(wholeHold).toBeDefined();
    if (!wholeHold) return;

    expect(wholeHold.lifecycle.states).toContain("disputed");
    expect(wholeHold.lifecycle.transitions.dispute).toEqual({
      from: ["funded"],
      to: "disputed",
    });
    expect(wholeHold.actions.dispute?.moves).toEqual([]);
    expect(wholeHold.actions.dispute?.steps).toEqual([]);
    expect(wholeHold.callerParkedStates?.disputed).toContain(
      "Dispute resolution is a human judgment; the parties resume the hold to continue.",
    );
  });

  test("resume unfreezes: transitions disputed hold back to funded without moving money, restoring release and unwind paths", () => {
    const multiPieceDoc = compileFixture("test/fixtures/car-escrow.hsx");
    const multiPieceSale = multiPieceDoc.instruments.find(
      (instrument) => instrument.id === "sale",
    );
    expect(multiPieceSale).toBeDefined();
    if (!multiPieceSale) return;

    expect(multiPieceSale.lifecycle.transitions.resume).toEqual({
      from: ["disputed"],
      to: "funded",
    });
    expect(multiPieceSale.actions.resume?.moves).toEqual([]);
    expect(multiPieceSale.actions.resume?.steps).toEqual([]);
    expect(multiPieceSale.actions.resume?.agentDescription).toContain(
      "Lift the dispute hold and put the sale back where it was, funded and ready to release.",
    );
    expect(multiPieceSale.actions.resume?.description).toContain(
      "Ends the dispute hold without moving money",
    );

    const wholeDoc = compileFixture("test/fixtures/whole-held-payment.hsx");
    const wholeHold = wholeDoc.instruments.find(
      (instrument) => instrument.id === "custody_hold",
    );
    expect(wholeHold).toBeDefined();
    if (!wholeHold) return;

    expect(wholeHold.lifecycle.transitions.resume).toEqual({
      from: ["disputed"],
      to: "funded",
    });
    expect(wholeHold.actions.resume?.moves).toEqual([]);
    expect(wholeHold.actions.resume?.steps).toEqual([]);
  });

  test("release while disputed refuses: release and cancel transitions disallow disputed state", () => {
    const multiPieceDoc = compileFixture("test/fixtures/car-escrow.hsx");
    const multiPieceSale = multiPieceDoc.instruments.find(
      (instrument) => instrument.id === "sale",
    );
    expect(multiPieceSale).toBeDefined();
    if (!multiPieceSale) return;

    expect(
      multiPieceSale.lifecycle.transitions.confirm_handover?.from,
    ).not.toContain("disputed");
    expect(multiPieceSale.lifecycle.transitions.confirm_handover?.from).toEqual(
      ["funded"],
    );
    expect(multiPieceSale.lifecycle.transitions.cancel?.from).not.toContain(
      "disputed",
    );
    expect(multiPieceSale.lifecycle.transitions.cancel?.from).toEqual([
      "funded",
    ]);
    expect(
      multiPieceSale.lifecycle.transitions.refund_piece_2?.from,
    ).not.toContain("disputed");
    expect(
      multiPieceSale.lifecycle.transitions.release_piece_2?.from,
    ).not.toContain("disputed");
    expect(
      multiPieceSale.lifecycle.transitions.release_piece_3?.from,
    ).not.toContain("disputed");
    expect(multiPieceSale.lifecycle.transitions.abandon?.from).not.toContain(
      "disputed",
    );

    const wholeDoc = compileFixture("test/fixtures/whole-held-payment.hsx");
    const wholeHold = wholeDoc.instruments.find(
      (instrument) => instrument.id === "custody_hold",
    );
    expect(wholeHold).toBeDefined();
    if (!wholeHold) return;

    expect(wholeHold.lifecycle.transitions.approve?.from).not.toContain(
      "disputed",
    );
    expect(wholeHold.lifecycle.transitions.approve?.from).toEqual(["funded"]);
    expect(
      wholeHold.lifecycle.transitions.release_on_deadline?.from,
    ).not.toContain("disputed");
    expect(wholeHold.lifecycle.transitions.cancel?.from).not.toContain(
      "disputed",
    );
    expect(wholeHold.lifecycle.transitions.abandon?.from).not.toContain(
      "disputed",
    );
  });
  test("quoted cancellation: prices the charge and the refund, pays the net to the payer, and sweeps the charge to the payee", () => {
    const document = compileFixture(
      "test/fixtures/held-payment-quoted-cancellation.hsx",
    );
    const deal = document.instruments.find(
      (instrument) => instrument.id === "deal",
    );
    expect(deal).toBeDefined();
    if (!deal) return;

    expect(deal.lifecycle.transitions.quote_cancellation).toEqual({
      from: ["funded", "cancellation_quoted"],
      to: "cancellation_quoted",
    });
    expect(deal.lifecycle.transitions.cancel).toEqual({
      from: ["cancellation_quoted"],
      to: "cancelled",
    });
    expect(deal.lifecycle.transitions.retain_cancellation_charge).toEqual({
      from: ["cancelled"],
      to: "settled",
    });
    expect(deal.lifecycle.transitions.dispute).toEqual({
      from: ["funded", "cancellation_quoted"],
      to: "disputed",
    });
    // A quote nobody spends never traps the money: the release still fires.
    expect(deal.lifecycle.transitions.confirm_delivery?.from).toEqual([
      "funded",
      "cancellation_quoted",
    ]);

    expect(deal.actions.quote_cancellation?.quote).toEqual({
      baseField: "price",
      chargeRef: "cancellationChargeAmount",
      charges: [{ bps: 500 }],
      expires: { offset: "PT30M" },
      fixes: ["price", "buyerAccountId"],
      netDestinationField: "buyerAccountId",
      netRef: "cancellationRefundAmount",
    });
    expect(deal.actions.quote_cancellation?.moves).toEqual([]);

    expect(deal.actions.cancel?.commit).toBe("quote_cancellation");
    expect(deal.actions.cancel?.moves?.[0]?.bind.amount).toEqual({
      from: "instance",
      path: "refs.cancellationRefundAmount",
    });
    expect(deal.actions.cancel?.moves?.[0]?.bind.sourceAccountId).toEqual({
      from: "instance",
      path: "refs.escrowAccountId",
    });
    expect(deal.actions.cancel?.moves?.[0]?.bind.destinationAccountId).toEqual({
      from: "instance",
      path: "fields.buyerAccountId",
    });

    expect(deal.actions.retain_cancellation_charge?.moves).toHaveLength(1);
    expect(
      deal.actions.retain_cancellation_charge?.moves?.[0]?.bind.amount,
    ).toEqual({ from: "instance", path: "refs.cancellationChargeAmount" });
    expect(
      deal.actions.retain_cancellation_charge?.moves?.[0]?.bind.sourceAccountId,
    ).toEqual({ from: "instance", path: "refs.escrowAccountId" });
    expect(
      deal.actions.retain_cancellation_charge?.moves?.[0]?.bind
        .destinationAccountId,
    ).toEqual({ from: "instance", path: "fields.sellerAccountId" });
  });
  test("quoted cancellation admits dispute while cancellation is quoted: preserves escrow before cancel is committed", () => {
    const document = compileFixture(
      "test/fixtures/held-payment-quoted-cancellation.hsx",
    );
    const deal = document.instruments.find(
      (instrument) => instrument.id === "deal",
    );
    expect(deal).toBeDefined();
    if (!deal) return;

    expect(deal.lifecycle.transitions.dispute).toEqual({
      from: ["funded", "cancellation_quoted"],
      to: "disputed",
    });
    expect(deal.lifecycle.transitions.resume).toEqual({
      from: ["disputed"],
      to: "funded",
    });
    expect(deal.lifecycle.transitions.quote_cancellation?.from).not.toContain(
      "disputed",
    );
    expect(deal.lifecycle.transitions.cancel?.from).not.toContain("disputed");
    expect(
      deal.lifecycle.transitions.retain_cancellation_charge?.from,
    ).not.toContain("disputed");
  });
  test("quoted cancellation refuses static on_cancel splits: one settlement cannot price its cancellation twice", () => {
    const source = readFileSync(
      join(packageRoot, "test/fixtures/held-payment-quoted-cancellation.hsx"),
      "utf8",
    ).replace(
      "  cancel_charge_bps: 500\n",
      "  on_cancel(funded) { buyer: 100% }\n  cancel_charge_bps: 500\n",
    );

    const result = compile(source, { moduleName: "on-cancel-clash" });

    expect(result.diagnostics[0]?.code).toBe("HSX1110");
    expect(result.diagnostics[0]?.message).toContain(
      "a quoted cancellation cannot combine with on_cancel splits",
    );
  });
  test("zero cancel charge bps retains quoted cancellation with a zero fee", () => {
    const document = compileFixture(
      "test/fixtures/held-payment-zero-cancellation-charge.hsx",
    );
    const deal = document.instruments.find(
      (instrument) => instrument.id === "deal",
    );
    expect(deal).toBeDefined();
    if (!deal) return;

    expect(deal.lifecycle.states).toContain("cancellation_quoted");
    expect(deal.lifecycle.transitions.quote_cancellation).toEqual({
      from: ["funded", "cancellation_quoted"],
      to: "cancellation_quoted",
    });
    expect(deal.lifecycle.transitions.cancel).toEqual({
      from: ["cancellation_quoted"],
      to: "cancelled",
    });
    expect(deal.lifecycle.transitions.retain_cancellation_charge).toEqual({
      from: ["cancelled"],
      to: "settled",
    });
    expect(deal.lifecycle.transitions.dispute).toEqual({
      from: ["funded", "cancellation_quoted"],
      to: "disputed",
    });
    expect(deal.actions.quote_cancellation?.quote?.charges).toEqual([
      { bps: 0 },
    ]);
    expect(deal.actions.retain_cancellation_charge?.moves).toEqual([]);
  });
  test("cancel offer life without cancel charge bps refuses compilation", () => {
    const source = readFileSync(
      join(packageRoot, "test/fixtures/held-payment-quoted-cancellation.hsx"),
      "utf8",
    ).replace("  cancel_charge_bps: 500\n", "");

    const result = compile(source, { moduleName: "missing-charge-bps" });

    expect(result.diagnostics[0]?.code).toBe("HSX1110");
    expect(result.diagnostics[0]?.message).toContain(
      "cancel_offer_life needs cancel_charge_bps to quote",
    );
  });
});
