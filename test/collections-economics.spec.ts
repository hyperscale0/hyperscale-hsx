import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

// Mutation: use programOperator as source or classify outside capital as a company payout.
test("collections fees bind their capital source and classify both participants", () => {
  for (const [capital, agency, purpose] of [
    ["operator", "collector", "participant_payout"],
    ["provider", "collector", "pass_through"],
    ["operator", "operator", "internal"],
    ["provider", "operator", "earning"],
  ] as const) {
    const result = compile(`program recovery "Recovery"
use financing
use collections
party provider: business
party collector: business
object purchase "Purchase" {
 attach limits = financing.limits { borrower: owner, per_borrower: 1000 SAR }
 attach budget = financing.portfolio_limit { limit: 10000 SAR }
 attach plan = financing.installments { borrower: owner, capital: ${capital}, months: 3, profit: 1%, disburse_to: borrower, limits: limits, portfolio: budget }
 attach case = collections.case { on: plan, capital: ${capital}, agency: ${agency} }
}`);
    expect(result.diagnostics).toEqual([]);
    const fee = result.artifacts!.document.instruments.find(
      (i) => i.id === "purchase_case",
    )!.actions.pay_fee!.moves[0]!;
    expect(fee.economics).toEqual({ purpose, sourceParty: capital });
  }
});
