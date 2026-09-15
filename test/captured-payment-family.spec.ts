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

describe("captured payment standard library", () => {
  test("manages custody reservation, partial capture, void, and reversal window", () => {
    const document = compileFixture("test/fixtures/captured-payment.hsx");
    const payment = document.instruments.find(
      (instrument) => instrument.id === "captured_payment",
    );
    expect(payment).toBeDefined();
    if (!payment) return;

    expect(payment.lifecycle.states).toEqual([
      "created",
      "authorized",
      "partially_captured",
      "settled",
      "voided",
      "expired",
      "corrected",
      "reversed",
    ]);

    expect(payment.actions.create?.moves).toEqual([]);
    expect(payment.actions.create?.steps).toEqual([]);

    expect(payment.actions.authorize?.moves?.[0]?.operation).toBe(
      "internal_transfer.reserve",
    );

    expect(payment.actions.capture?.moves?.[0]?.operation).toBe(
      "internal_transfer.post",
    );
    expect(payment.actions.capture?.moves?.[0]?.capture).toEqual({
      capturedAmount: "postedAmount",
    });

    expect(payment.actions.void?.moves?.[0]?.operation).toBe(
      "internal_transfer.void",
    );

    expect(payment.actions.correct_payment?.port?.allowedParties).toEqual([
      "beneficiary",
    ]);
    expect(payment.actions.correct_payment?.moves?.[0]?.bind.amount).toEqual({
      from: "instance",
      path: "refs.capturedAmount",
    });

    expect(payment.actions.reverse_payment?.port?.allowedParties).toEqual([
      "beneficiary",
    ]);
    expect(payment.actions.reverse_payment?.deadline?.field).toBe(
      "reversalUntil",
    );
    expect(payment.actions.reverse_payment?.moves?.[0]?.bind.amount).toEqual({
      from: "instance",
      path: "refs.capturedAmount",
    });
  });

  test("honors correction and reversal port shapes and multi-party allowed mappings", () => {
    const source = `program test_captured_payment "Test captured payment"
import { captured_payment } from "std/money_flows"

party buyer: person
party seller: business

settlement card_payment = captured_payment {
  payer: buyer
  payee: seller
  amount: total: money(SAR)
  reserve_until: reserveUntil
  correction: port correct_payment
  external_reversal: port reverse_payment within P30D
}

port correct_payment {
  allowed: [seller]
  shape { correctionReason: text }
}

port reverse_payment {
  allowed: [buyer, seller]
  shape { reversalNote: text }
}`;
    const result = compile(source);
    expect(result.diagnostics).toEqual([]);
    const document = result.artifacts?.document as UdlDocument;
    const payment = document.instruments.find((i) => i.id === "card_payment");
    expect(payment?.actions.correct_payment?.input?.required).toEqual([
      "correctionReason",
    ]);
    expect(payment?.actions.correct_payment?.port?.allowedParties).toEqual([
      "beneficiary",
    ]);
    expect(payment?.actions.reverse_payment?.input?.required).toEqual([
      "reversalNote",
    ]);
    expect(payment?.actions.reverse_payment?.port?.allowedParties).toEqual([
      "payer",
      "beneficiary",
    ]);
  });
});
