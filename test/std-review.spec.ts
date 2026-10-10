import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";
import { buildUdlCostManifest } from "../src/cost.ts";

const standardLibrary = {
  source: (name: string) =>
    readFileSync(new URL(`../std/${name}.hsx`, import.meta.url), "utf8"),
};
const sample = (name: string) =>
  readFileSync(new URL(`../examples/${name}.hsx`, import.meta.url), "utf8");
function document(source: string) {
  const result = compile(source, { standardLibrary });
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  return result.artifacts.document;
}
function instrument(source: string, id: string) {
  const found = document(source).instruments.find((item) => item.id === id);
  if (!found) throw new Error(`Missing instrument ${id}`);
  return found;
}

// Mutation: remove the holder-state requirement from create or approve.
test("card authorization checks holder suspension at creation and reservation", () => {
  const authorization = instrument(sample("cards"), "employee_payment");
  for (const action of ["create", "approve"])
    expect(authorization.actions[action]!.requires).toContainEqual({
      kind: "state",
      reference: "self.card.holder",
      states: ["active"],
    });
});

// Mutation: remove the wallet-holder equality requirement.
test("a commitment can debit only the bound investor's wallet", () => {
  const commitment = instrument(sample("lending"), "business_investment");
  expect(commitment.actions.create!.requires).toContainEqual({
    kind: "compare",
    left: { field: "self.wallet.holder" },
    operator: "==",
    right: { field: "self.investor" },
  });
});

// Mutation: group the cumulative cap by wallet instead of investor.
test("opening another wallet does not reset an investor's round cap", () => {
  const commitment = instrument(sample("lending"), "business_investment");
  const cap = (commitment.invariants ?? []).find(
    (rule) =>
      rule.kind === "aggregate" &&
      "field" in rule.value &&
      rule.value.field === "self.round.maximumTicket",
  );
  if (!cap || cap.kind !== "aggregate") throw new Error("Missing investor cap");
  expect(cap.selection.where).toEqual({ investor: { field: "self.investor" } });
});

// Mutation: remove the paid-contribution bound. r339: the bound is the 253
// transfers one ledger request takes, since failure refunds every paid
// contribution in one linked request.
test("a pool cannot accept more paid contributions than failure can refund", () => {
  const pool = instrument(
    `program p "Pool"
use money
object campaign "Campaign" {
  attach pool = money.pool { payer: actor, payee: owner, target: 1000 SAR, closes: 2027-01-01 }
}`,
    "campaign_pool_contribution",
  );
  expect(pool.invariants).toContainEqual({
    kind: "aggregate",
    selection: {
      instrument: "campaign_pool_contribution",
      reference: "pool",
      anchor: "self.pool",
      states: ["paid"],
      limit: 253,
    },
    measure: "count",
    operator: "<=",
    value: { literal: 253 },
  });
});

// r339-fix: a round's failure refunds every commitment and a cash
// distribution pays every share in one ledger request of 253 transfers.
// Mutation: lift the commitment bound or a round selection back to 366, and
// a round of 254 commitments can neither fail nor distribute.
test("a lending round takes no more commitments than one ledger request refunds and distributes", () => {
  const lending = document(sample("lending"));
  const commitment = lending.instruments.find(
    (item) => item.id === "business_investment",
  )!;
  expect(commitment.invariants).toContainEqual({
    kind: "aggregate",
    selection: {
      instrument: ["business_investment"],
      reference: "round",
      anchor: "self.round",
      states: ["committed", "funded"],
      limit: 248,
    },
    measure: "count",
    operator: "<=",
    value: { literal: 248 },
  });
  const { actions } = buildUdlCostManifest(lending);
  for (const [name, cost] of [
    ["business_funding.close", 1],
    ["business_funding.fail", 248],
    ["business_returns.distribute_cash", 253],
    ["business_losses.distribute_loss", 250],
  ] as const)
    expect([name, actions[name]!.transfers]).toEqual([name, cost]);
});

// Mutation: remove allowZero from the recovery-cost assessment.
test("a zero recovery-cost cap still permits assessment", () => {
  const cost = instrument(
    sample("serviced").replace("cap: 25 SAR", "cap: 0 SAR"),
    "car_late_cost",
  );
  expect(cost.actions.assess!.allowZero).toBe(true);
});

// Mutation: drop earned profit from totalOutstanding or test only scheduledOutstanding.
test("report arrears include earned profit after principal is repaid", () => {
  const reports = instrument(sample("reporting"), "purchase_reports").reports!;
  for (const report of reports) {
    const schedule = report.datasets.find(
      (dataset) => dataset.id === "schedule",
    )!;
    expect(
      schedule.columns.find((column) => column.name === "earnedProfit"),
    ).toEqual({
      name: "earnedProfit",
      field: "earnedProfit",
      type: { kind: "money", currency: "SAR" },
      required: true,
    });
    expect(schedule.expressions).toContainEqual({
      id: "totalOutstanding",
      op: "sum",
      left: "scheduledOutstanding",
      right: "earnedProfit",
    });
    expect(schedule.expressions).toContainEqual({
      id: "unpaid",
      op: "less",
      left: "zeroMoney",
      right: "totalOutstanding",
    });
  }
});
