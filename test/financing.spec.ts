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
test("the schedule bound follows max_term, not the months a program picks", () => {
  for (const [terms, maximum] of [
    ["months: 1", 84],
    ["months: 3", 84],
    ["months: 84", 84],
    ["loan_kind: short_term, months: 12", 12],
    ["loan_kind: auto, months: 84", 84],
    ["loan_kind: mortgage, months: 360", 360],
    ["loan_kind: mortgage, max_term: 120, months: 3", 120],
  ] as const) {
    const res = compile(source.replace("months: 3", terms));
    const doc = res.artifacts?.document;
    if (!doc) throw new Error(JSON.stringify(res.diagnostics));
    expect(
      buildUdlCostManifest(doc).actions["car_plan.create"]!.invocations,
    ).toBe(maximum * 3 + 1);
  }
});
test("financing refuses schedules outside the std bound", () => {
  for (const months of [0, 361])
    expect(
      compile(source.replace("months: 3", `months: ${months}`)).verdict,
    ).toBe("invalid");
});
// Mutation: let a tenant raise max_term, or default it above the kind's ceiling.
test("each loan kind caps the term and a tenant may only lower it", () => {
  for (const [terms, message] of [
    ["months: 85", "months must be at_most max_term"],
    ["loan_kind: short_term, months: 13", "months must be at_most max_term"],
    ["max_term: 85, months: 3", "max_term for personal is at most 84"],
    [
      "loan_kind: auto, max_term: 120, months: 3",
      "max_term for auto is at most 84",
    ],
    [
      "loan_kind: mortgage, max_term: 24, months: 36",
      "months must be at_most max_term",
    ],
  ] as const) {
    const res = compile(source.replace("months: 3", terms));
    expect([terms, res.verdict]).toEqual([terms, "invalid"]);
    expect(res.diagnostics.map((item) => item.message).join("\n")).toContain(
      message,
    );
  }
  for (const terms of [
    "loan_kind: mortgage, months: 360",
    "loan_kind: auto, max_term: 60, months: 60",
    "loan_kind: short_term, months: 4",
  ])
    expect([
      terms,
      compile(source.replace("months: 3", terms)).verdict,
    ]).toEqual([terms, "valid"]);
});
// Mutation: post one transfer per remaining slice or per charge again.
test("every financing action of a 360-month plan fits one 253-transfer batch", () => {
  const witness = source
    .replace("months: 3", "loan_kind: mortgage, months: 360")
    .replace(
      /(?=  attach plan = financing\.installments)/,
      `  attach late = financing.late_charge { on: plan, fines_to: operator, costs_to: operator, borrower: actor }\n`,
    );
  const result = compile(witness);
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  const actions = buildUdlCostManifest(result.artifacts.document).actions;
  const over = Object.entries(actions)
    .filter(([, cost]) => cost.transfers > 253 || cost.invocations >= 8192)
    .map(([name, cost]) => [name, cost.transfers, cost.invocations]);
  expect(over).toEqual([]);
  for (const name of [
    "car_plan.disburse",
    "car_plan.payoff",
    "car_plan.write_off",
    "car_plan.unwind",
    "car_plan.unwind_undelivered",
  ])
    expect([name, actions[name]!.transfers <= 32]).toEqual([name, true]);
});
test("all financing enum policy combinations compile", () => {
  // The example exposes escrow returns; borrower-directed plans exclude them.
  const policySource = source.replace(
    /^    expose unwind(?:_undelivered|_paid)? as .*\n/gm,
    "",
  );
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
                policySource.replace(
                  "months: 3",
                  `months: 3, disburse_to: ${d}, profit_earned: ${p}, apply: ${a}, allow_overdue: ${o}, assessed_fines: ${f}`,
                ),
              ).verdict,
            ).toBe("valid");
});

test("late-charge waterfall derives its expansion bound without an authored override", () => {
  const witness = source
    .replace("months: 3", "loan_kind: mortgage, months: 360")
    .replace(
      /(?=  attach plan = financing\.installments)/,
      `  attach late = financing.late_charge { on: plan, fines_to: operator, costs_to: operator, borrower: actor }\n`,
    );
  const result = compile(witness);
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  const document = result.artifacts.document;
  const cost =
    buildUdlCostManifest(document).actions["car_plan_payment.pay"]!
      .invocations + 1;
  expect(cost).toBeGreaterThan(1024);
  expect(cost).toBeLessThanOrEqual(8192);
  expect(JSON.stringify(document)).not.toContain("expansionLimit");
  expect(validateUdl(document).ok).toBe(true);
});

test("source-backed compilation accepts all five changed std modules", () => {
  const p = `program p "All"
use money
use escrow
use purchase
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
  attach sale = escrow.hold { funding: { controllers: [checkout], reference: "funds", blocking_states: [active] }, payer: actor, payee: owner }
  attach limits = financing.limits { borrower: actor, per_borrower: 60000 SAR }
  attach ceiling = financing.portfolio_limit { limit: 1500000 SAR }
  attach checkout = purchase.checkout { plans: plan, funds: sale, borrower: actor, capital: operator }
  attach plan = financing.installments { borrower: actor, capital: operator, share: 25%, months: 3, pricing: flat_total, profit_rate: 2.5%, down_payment: 20%, funds: checkout, limits: limits, portfolio: ceiling }
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
    "costReceivable",
    "debt",
    "fineReceivable",
    "loss",
    "principalReceivable",
    "profitEarned",
    "profitIncome",
    "profitReceivable",
  ]);
});

test("pricing selects annuity rows or the flat split and has no default", () => {
  const slice = (text: string) => {
    const res = compile(text);
    expect(res.diagnostics).toEqual([]);
    return res.artifacts!.document.instruments.find(
      (i) => i.id === "car_plan_slice",
    )!;
  };
  const amortizing = slice(
    source.replace("pricing: flat_total", "pricing: amortizing"),
  );
  expect(
    (amortizing.actions.create!.calculate ?? []).map((c) => [c.target, c.op]),
  ).toEqual([
    ["openPrincipal", "sum"],
    ["openProfit", "sum"],
    ["earnedProfit", "sum"],
    ["principal", "annuity"],
    ["profit", "annuity"],
    ["instalment", "sum"],
  ]);
  const flat = slice(source);
  expect(
    (flat.actions.create!.calculate ?? []).filter((c) => c.op === "annuity"),
  ).toEqual([]);
  expect(
    compile(source.replace("pricing: flat_total, ", "")).diagnostics[0]
      ?.message,
  ).toContain("pricing");
});
