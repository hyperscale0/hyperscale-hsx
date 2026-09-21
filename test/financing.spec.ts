import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile as compileHsx } from "../src/compile.ts";
import { validateUdl } from "@hyperscale0/udl";
import { buildUdlCostManifest } from "../src/cost.ts";

const source = readFileSync(
  new URL("../examples/library.hsx", import.meta.url),
  "utf8",
);
// Read the owned std source; L21 regenerates the committed bundle.
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
      `\n attach late = financing.late_charge { on: plan, fines_to: operator, costs_to: operator, approval: underwriter, borrower: actor }\n}`,
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
  const p =
    'program p "All"\nuse money\nuse escrow\nuse financing\nuse insurance\nuse travel\nuse lending\nuse wallet\nparty underwriter: staff role credit_underwriter\nparty insurer: business\nparty supplier: business\nparty inspector: staff role claim_inspector\nparty investor: business\nobject item "Item" {\n  attach pay = money.transfer { payer: actor, payee: owner, amount: 750 SAR }\n  attach pack = travel.package { price: 1000 SAR, supplier_cost: 700 SAR, departure: 2027-01-01 }\n  attach cov = insurance.cover { holder: actor, insurer: insurer, approval: inspector, covers: book }\n  attach book = travel.booking { package: pack, buyer: actor, supplier: supplier, approval: inspector, cover: cov }\n  attach clm = insurance.claim { cover: cov, approved_by: inspector }\n  attach sale = escrow.hold { payer: actor, payee: owner }\n  attach limits = financing.limits { borrower: actor, per_borrower: 60000 SAR, portfolio: 1500000 SAR }\n  attach plan = financing.installments { borrower: actor, capital: operator, share: 25%, approval: underwriter, months: 3, profit: 2.5%, down_payment: 20%, funds: sale, limits: limits }\n  attach inv_wallet = wallet.balance { holder: investor }\n  attach round = lending.round { borrower: actor, plan: plan, minimum_ticket: 100 SAR, investor_cap: 100% }\n  attach commit = lending.commitment { round: round, wallet: inv_wallet, investor: investor }\n  attach dist = lending.distribution { round: round, receipt: plan.settlement, fee: 0%, tax: 0% }\n}';
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
  const hasDiffInit = (id: string, act: string) =>
    doc.instruments
      .find((i) => i.id === id)!
      .actions[act]!.requires.some(
        (r) => r.kind === "approval" && r.differentFromInitiator,
      );
  expect(hasDiffInit("item_cov", "activate")).toBe(true);
  expect(hasDiffInit("item_book", "confirm")).toBe(true);
});
