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
});
