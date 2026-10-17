import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { projectDocumentSemantics } from "@hyperscale0/udl";
import { compile } from "../src/compile.ts";

function effects(example: string, instrument: string, action: string) {
  const document = compile(
    readFileSync(
      new URL(`../examples/${example}.hsx`, import.meta.url),
      "utf8",
    ),
  ).artifacts!.document;
  return projectDocumentSemantics(document)
    .instruments.find((item) => item.id === instrument)!
    .actions.find((item) => item.name === action)!.moneyEffects;
}

// Mutation: drop the floor on a rate, multiply nested rates without scaling, or drop reversalOf.
test("a commission on a constant premium carries its share, floor-rounded value and reversal", () => {
  // 115 SAR premium, 10% commission: 11.50 SAR to the retailer, 103.50 SAR to the insurer.
  const [insurer, commission] = effects(
    "insurance",
    "device_protection_slice",
    "collect",
  );
  expect(commission).toMatchObject({
    amount: { field: "self.commission" },
    economics: { purpose: "earning", sourceParty: "owner", reversalOf: null },
    share: { base: "self.premium", bps: 1000, value: "1150" },
  });
  expect(insurer!.share).toEqual({
    base: "self.premium",
    bps: 9000,
    value: "10350",
  });
  const refund = effects("insurance", "device_protection_slice", "refund");
  expect(refund[1]!.economics).toEqual({
    purpose: "earning",
    sourceParty: "operator",
    reversalOf: "self.commissionReceipt",
  });
  expect(
    effects("reporting", "purchase_loan", "disburse").map(
      (effect) => effect.economics?.purpose,
    ),
  ).toEqual(["principal", "internal", "internal"]);
});

// Mutation: evaluate a rate against a base the agreement supplies, or report a share for a mixed-base subtraction.
test("a share of an agreement's price has no value, and a mixed-base amount has no share", () => {
  const [net, fee, tax] = effects("escrow", "device_sale", "accept");
  expect([net, fee, tax].map((effect) => effect!.share)).toEqual([
    { base: "subject.price", bps: 9425, value: null },
    { base: "subject.price", bps: 500, value: null },
    { base: "subject.price", bps: 75, value: null },
  ]);
  // The refund is the held balance less the constant late fee and its tax: two bases.
  const [lateFee, lateTax, refund] = effects(
    "rental-deposit",
    "rental_security",
    "return_late",
  );
  expect(lateFee!.share).toEqual({
    base: "self.lateFee",
    bps: 10_000,
    value: "5000",
  });
  expect(lateTax!.share).toEqual({
    base: "self.lateFee",
    bps: 1500,
    value: "750",
  });
  expect(refund!.amount).toEqual({ field: "self.refund" });
  expect(refund!.share).toBeNull();
  expect(refund!.economics).toBeNull();
});
