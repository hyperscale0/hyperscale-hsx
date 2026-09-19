import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { validateUdl } from "@hyperscale0/udl";
import { buildUdlCostManifest } from "../src/cost.ts";

// A dealer financing programme in the shape of Darb Cars, kept inside the
// package so the exported tests do not depend on the platform tree.
const source = `program dealer "Dealer"

use marketplace
use vehicles
use escrow
use financing
use collections

party buyer: person
party seller: business
party underwriter: staff role credit_underwriter
party agency: business role collections_agency

listing = marketplace.listing { seller: seller, vehicle_facts: required }
vehicle = vehicles.vehicle { listing: listing, seller: seller }
order = marketplace.order { listing: listing, buyer: buyer }
sale = escrow.hold { payer: buyer, payee: seller, for: order, accept_within: 48h }
limits = financing.limits { per_borrower: 60000 SAR, portfolio: 1500000 SAR, borrower: buyer, active_plans: 1 }
plan_3 = financing.installments { months: 3, profit: 2.5%, down_payment: 20%, funds: sale, approval: underwriter }
late = financing.late_charge { on: [plan_3], grace: 3d, fine: 50 SAR, cap: 25 SAR, approval: underwriter }
referral = collections.case { on: [plan_3], agency: agency, overdue: 3d }
`;
test("financing range accepts the full schedule domain and costs nested children", () => {
  for (const months of [1, 3, 6, 16, 17, 365, 366]) {
    const result = compile(source.replace("months: 3", `months: ${months}`));
    if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
    // Mutation: omit the nested refresh_loss_date action from recursive cost.
    expect(
      buildUdlCostManifest(result.artifacts.document).actions["plan_3.create"]!
        .invocations,
    ).toBe(months * 2);
  }
});
test("financing refuses schedules outside the std bound", () => {
  for (const months of [0, 367])
    expect(
      compile(source.replace("months: 3", `months: ${months}`)).verdict,
    ).toBe("invalid");
});
test("all financing enum policy combinations compile", () => {
  for (const disburse of ["funds", "borrower"])
    for (const recognition of ["on_payment", "by_schedule", "at_disbursement"])
      for (const order of [
        "fines_profit_principal",
        "principal_profit",
        "pro_rata",
      ])
        for (const overdue of ["allowed", "blocked"])
          for (const fines of ["carry", "require_waiver"]) {
            const result = compile(
              source.replace(
                "months: 3",
                `months: 3, disburse_to: ${disburse}, profit_earned: ${recognition}, apply: ${order}, allow_overdue: ${overdue}, assessed_fines: ${fines}`,
              ),
            );
            if (!result.artifacts)
              throw new Error(
                JSON.stringify({
                  disburse,
                  recognition,
                  order,
                  overdue,
                  fines,
                  diagnostics: result.diagnostics,
                }),
              );
          }
});

test("the bounded waterfall fits its explicit ceiling while ordinary actions retain 4096", () => {
  // Mutation: omit the static recursive expansion limit check.
  const result = compile(source.replace("months: 3", "months: 366"));
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  const document = result.artifacts.document;
  const costs = buildUdlCostManifest(document).actions;
  for (const [id, name] of [
    ["plan_3_payment", "pay"],
    ["referral", "recover"],
  ]) {
    const cost = costs[`${id}.${name}`]!.invocations + 1;
    expect(cost).toBeGreaterThan(4096);
    expect(cost).toBeLessThanOrEqual(8192);
    const ordinary = structuredClone(document);
    delete ordinary.instruments.find((item) => item.id === id)!.actions[name!]!
      .expansionLimit;
    const verdict = validateUdl(ordinary);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(
        verdict.issues.some(
          (issue) =>
            issue.message === `invocation ${id}.${name} exceeds 4096 actions`,
        ),
      ).toBe(true);
  }
});
