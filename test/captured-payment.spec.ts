import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkProgram, compile, parseProgram } from "../src/index.ts";

type Json = Record<string, any>;

const SOURCE = readFileSync(
  join(import.meta.dir, "fixtures", "captured-payment.hsx"),
  "utf8",
);

describe("captured_payment", () => {
  it("checks to mechanism vocabulary with no acquiring role names", () => {
    const parsed = parseProgram(SOURCE);
    expect(parsed.diagnostics).toEqual([]);
    const checked = checkProgram(parsed.program);
    expect(checked.diagnostics).toEqual([]);
    const settlement = checked.program?.settlements[0];
    expect(settlement).toMatchObject({
      archetype: "captured_payment",
      name: "captured_payment",
      payee: "payee",
      payer: "payer",
      reserveUntilField: "reserveUntil",
    });
    expect(Object.keys(settlement ?? {}).join(" ")).not.toMatch(
      /merchant|chargeback/,
    );
  });

  it("lowers reserve, repeatable capture, correction, and reversal to four events", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const noun = (result.artifacts.document.nouns as Json[])[0]!;
    expect(Object.keys(noun.verbs)).toEqual([
      "create",
      "authorize",
      "capture",
      "capture_more",
      "settle",
      "void",
      "expire",
      "settle_on_expiry",
      "correct_payment",
      "reverse_payment",
    ]);
    expect(
      Object.fromEntries(
        (Object.entries(noun.verbs) as [string, Json][]).map(
          ([verb, definition]) => [verb, definition.publicIntent],
        ),
      ),
    ).toEqual({
      authorize: "authorizeCapturedPayment",
      capture: "captureCapturedPayment",
      capture_more: "captureMoreCapturedPayment",
      correct_payment: "correctPaymentCapturedPayment",
      create: "createCapturedPayment",
      expire: undefined,
      reverse_payment: "reversePaymentCapturedPayment",
      settle: "settleCapturedPayment",
      settle_on_expiry: undefined,
      void: "voidCapturedPayment",
    });
    expect(noun.verbs.authorize.moves[0]).toMatchObject({
      amount: "total",
      operation: "reserve",
    });
    expect(noun.verbs.authorize.moves[0]).not.toHaveProperty("expiresAt");
    expect(noun.verbs.capture.moves[0]).toMatchObject({
      amount: "captureAmount",
      capture: { capturedAmount: "postedAmount" },
      operation: "post",
      partialOnly: true,
    });
    expect(noun.verbs.settle.moves[0]).toMatchObject({
      capture: { capturedAmount: "postedAmount" },
      operation: "post",
    });
    expect(noun.verbs.settle.setsAt).toEqual({
      field: "reversalUntil",
      offset: "P120D",
    });
    expect(noun.verbs.settle_on_expiry.setsAt).toEqual({
      field: "reversalUntil",
      offset: "P120D",
    });
    expect(noun.verbs.correct_payment.moves[0]).toMatchObject({
      amount: "refs.capturedAmount",
      from: "payee",
      operation: "create",
      to: "payer",
    });
    expect(noun.verbs.correct_payment).toMatchObject({
      from: ["settled"],
      to: "corrected",
    });
    expect(noun.verbs.reverse_payment).toMatchObject({
      captureInput: { externalReference: "externalReference" },
      deadline: { field: "reversalUntil" },
      from: ["settled"],
      port: {
        allowed: ["payee"],
        fields: { externalReference: "text" },
      },
      to: "reversed",
    });
    const events = result.artifacts.frame.moneyEvents as Json[];
    expect(events.map((event) => event.key)).toEqual([
      "captured_payment_reserve",
      "captured_payment_capture",
      "captured_payment_correction",
      "captured_payment_external_reversal",
    ]);
    expect(events[1]).toMatchObject({
      amountDependencies: ["captured_payment_reserve"],
      amountMode: "runtime_bounded",
      occurrence: "repeatable",
    });
  });

  it("refuses unsupported correction, negative-position, timeout, and fee policies", () => {
    const changed = SOURCE.replace(
      "capture_mode: partial_then_full",
      "capture_mode: full_only",
    )
      .replace("correction_mode: full_only", "correction_mode: partial")
      .replace("negative_position: reject", "negative_position: allow")
      .replace("timeout: reject", "timeout: retry")
      .replace("timeout: retry", "timeout: retry\n  fees { payer: 1% }");
    const result = compile(changed);
    expect(result.verdict).toBe("invalid");
    const messages = result.diagnostics.map((item) => item.message).join("\n");
    expect(messages).toContain("capture calls must leave a remainder");
    expect(messages).toContain("repeated partial corrections");
    expect(messages).toContain("must fail when the payee cannot fund it");
    expect(messages).toContain("timeout records no money movement");
    expect(messages).toContain("does not price fees inside captured_payment");
  });

  it("requires a payee-only correction and external decision reference", () => {
    const changed = SOURCE.replace(
      "allowed: [payee]\n}\n\nport reverse_payment",
      "allowed: [payer]\n}\n\nport reverse_payment",
    ).replace("shape: { externalReference: text }", "shape: { note: text }");
    const result = compile(changed);
    expect(result.verdict).toBe("invalid");
    const messages = result.diagnostics.map((item) => item.message).join("\n");
    expect(messages).toContain("must allow only its payee payee");
    expect(messages).toContain("needs shape { externalReference: text }");
  });
});
