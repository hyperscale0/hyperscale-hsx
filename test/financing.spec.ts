import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile as compileHsx } from "../src/compile.ts";
import { validateUdl } from "@hyperscale0/udl";
import { buildUdlCostManifest } from "../src/cost.ts";

const source = readFileSync(
  new URL("../examples/library.hsx", import.meta.url),
  "utf8",
);
// Read the std source, not the generated bundle.
const compile = (source: string) =>
  compileHsx(source, {
    standardLibrary: {
      source: (name) =>
        readFileSync(new URL(`../std/${name}.hsx`, import.meta.url), "utf8"),
    },
  });
test("financing range accepts the full schedule domain and costs nested children", () => {
  for (const m of [1, 3, 6, 16, 17, 365, 366]) {
    const res = compile(source.replace("months: 3", `months: ${m}`));
    const doc = res.artifacts?.document;
    if (!doc) throw new Error(JSON.stringify(res.diagnostics));
    expect(
      buildUdlCostManifest(doc).actions["car_plan.create"]!.invocations,
    ).toBe(m * 2);
  }
});
test("financing refuses schedules outside the std bound", () => {
  for (const months of [0, 367])
    expect(
      compile(source.replace("months: 3", `months: ${months}`)).verdict,
    ).toBe("invalid");
});
test("all financing enum policy combinations compile", () => {
  for (const d of ["funds", "borrower"])
    for (const p of ["on_payment", "by_schedule", "at_disbursement"])
      for (const a of [
        "fines_profit_principal",
        "principal_profit",
        "pro_rata",
      ])
        for (const o of ["allowed", "blocked"])
          for (const f of ["carry", "require_waiver"])
            expect(
              compile(
                source.replace(
                  "months: 3",
                  `months: 3, disburse_to: ${d}, profit_earned: ${p}, apply: ${a}, allow_overdue: ${o}, assessed_fines: ${f}`,
                ),
              ).verdict,
            ).toBe("valid");
});

test("late-charge waterfall needs the bounded ceiling while ordinary actions retain 4096", () => {
  const witness = source
    .replace("months: 3", "months: 366")
    .replace(
      /\}\s*$/,
      `\n attach late = financing.late_charge { on: plan, fines_to: operator, costs_to: operator, borrower: actor }\n}`,
    );
  const result = compile(witness);
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  const document = result.artifacts.document;
  const cost =
    buildUdlCostManifest(document).actions["car_plan_payment.pay"]!
      .invocations + 1;
  expect(cost).toBeGreaterThan(4096);
  expect(cost).toBeLessThanOrEqual(8192);
  delete document.instruments.find((item) => item.id === "car_plan_payment")!
    .actions.pay!.expansionLimit;
  const ordinary = validateUdl(document);
  expect(ordinary.ok).toBe(false);
  if (!ordinary.ok)
    expect(ordinary.issues.map((i) => i.message)).toContain(
      "invocation car_plan_payment.pay exceeds 4096 actions",
    );
});

test("source-backed compilation accepts all five changed std modules", () => {
  const p = `program p "All"
use money
use escrow
use financing
use insurance
use lending
use wallet
party supplier: business
party inspector: staff role claim_inspector
party investor: business
object item "Item" {
  attach pay = money.transfer { payer: actor, payee: owner, amount: 750 SAR }
  attach cov = insurance.cover { holder: actor, adapter: "motor_insurer", covers: sale }
  attach clm = insurance.claim { cover: cov, inspector: inspector }
  attach sale = escrow.hold { payer: actor, payee: owner }
  attach limits = financing.limits { borrower: actor, per_borrower: 60000 SAR }
  attach ceiling = financing.portfolio_limit { limit: 1500000 SAR }
  attach plan = financing.installments { borrower: actor, capital: operator, share: 25%, months: 3, profit: 2.5%, down_payment: 20%, funds: sale, limits: limits, portfolio: ceiling }
  attach inv_wallet = wallet.balance { holder: investor }
  attach round = lending.round { borrower: actor, plan: plan, minimum_ticket: 100 SAR, investor_cap: 100% }
  attach commit = lending.commitment { round: round, wallet: inv_wallet, investor: investor }
  attach dist = lending.distribution { round: round, receipt: plan.settlement, fee: 0%, tax: 0% }
}`;
  const res = compile(p);
  expect(res.verdict).toBe("valid");
  const doc = res.artifacts!.document;
  const partner = /bank|carrier|distributor/i;
  const names = doc.instruments.flatMap((inst) =>
    inst.fields.flatMap((f) => [
      f.name,
      ...("target" in f && typeof f.target === "string" ? [f.target] : []),
    ]),
  );
  expect(names.filter((name) => partner.test(name))).toEqual([]);
  const plan = doc.instruments.find((i) => i.id === "item_plan");
  if (!plan) throw new Error("Missing item_plan instrument");
  expect(
    plan.fields
      .filter((f) => f.type === "account")
      .map((f) => f.name)
      .sort(),
  ).toEqual([
    "allocatedPayable",
    "borrower",
    "capital",
    "loss",
    "profitIncome",
  ]);
});
