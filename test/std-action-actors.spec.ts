import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

const program = `program p "All"
use money
use escrow
use financing
use insurance
use travel
use lending
use wallet
use cards
use collections
party supplier: business
party inspector: staff role claim_inspector
party investor: business
object item "Item" {
  attach tr = money.transfer { payer: actor, payee: owner, amount: 750 SAR }
  attach hold = money.hold { payer: actor, payee: owner, amount: 750 SAR }
  attach split = money.split { payer: actor, amount: 750 SAR }
  attach pool = money.pool { payer: actor, payee: owner, target: 1000 SAR, closes: 2027-01-01 }
  attach swap = money.swap { first: actor, second: owner, first_amount: 100 SAR, second_amount: 200 SAR, expires: 2027-01-01 }
  attach metered = money.metered { payer: actor, payee: owner, unit_price: 10 SAR }
  attach pack = travel.package { price: 1000 SAR, supplier_cost: 700 SAR, departure: 2027-01-01 }
  attach cov = insurance.cover { holder: actor, adapter: "motor_insurer", covers: book }
  attach book = travel.booking { package: pack, buyer: actor, supplier: supplier, cover: cov }
  attach clm = insurance.claim { cover: cov, inspector: inspector }
  attach sale = escrow.hold { payer: actor, payee: owner }
  attach limits = financing.limits { borrower: actor, per_borrower: 60000 SAR }
  attach ceiling = financing.portfolio_limit { limit: 1500000 SAR }
  attach plan = financing.installments { borrower: actor, capital: operator, share: 25%, months: 3, profit: 2.5%, down_payment: 20%, funds: sale, limits: limits, portfolio: ceiling }
  attach late = financing.late_charge { on: plan, borrower: actor, fines_to: operator, costs_to: operator }
  attach case = collections.case { on: plan, agency: supplier, capital: operator }
  attach inv_wallet = wallet.balance { holder: investor }
  attach spend = wallet.spend { wallet: inv_wallet, payee: supplier }
  attach round = lending.round { borrower: actor, plan: plan, minimum_ticket: 100 SAR, investor_cap: 100% }
  attach commit = lending.commitment { round: round, wallet: inv_wallet, investor: investor }
  attach dist = lending.distribution { round: round, receipt: plan.settlement, fee: 0%, tax: 0% }
  attach cardholder = cards.cardholder { holder: actor }
  attach card = cards.card { holder: cardholder, spend_limit: 5000 SAR }
  attach auth = cards.authorization { card: card, merchant: supplier }
  attach txn = cards.transaction { authorization: auth }
  attach disp = cards.dispute { transaction: txn }
}`;

test("standard library money-moving, releasing, forgiving or refunding actions bind explicit actors", () => {
  const result = compile(program);
  expect(result.diagnostics).toEqual([]);
  const doc = result.artifacts!.document;
  expect(doc.instruments.length).toBeGreaterThan(30);

  const moneyMovingInvocations = new Set([
    "write_off",
    "waive",
    "refund",
    "pay",
    "pay_fee",
    "distribute_cash",
    "distribute_loss",
  ]);
  const explicitMoneyActions = new Set([
    "disburse",
    "assign",
    "release",
    "refund",
  ]);

  for (const inst of doc.instruments) {
    for (const [actionName, action] of Object.entries(inst.actions)) {
      const movesMoney =
        (action.moves?.length ?? 0) > 0 ||
        (action.invoke ?? []).some((inv) =>
          moneyMovingInvocations.has(inv.action),
        ) ||
        explicitMoneyActions.has(actionName);
      if (movesMoney) {
        expect(action.actor).not.toBe("caller");
        expect(action.actor).toBeDefined();
      }
    }
  }

  const find = (id: string, act: string) =>
    doc.instruments.find((i) => i.id === id)?.actions[act]?.actor;
  expect(find("item_plan", "disburse")).toEqual({ party: "operator" });
  expect(find("item_plan_write_off_request", "apply")).toEqual({
    party: "operator",
  });
  expect(find("item_plan_amendment", "create")).toEqual({ party: "operator" });
  expect(find("item_plan_amendment", "accept")).toEqual({ party: "actor" });
  expect(find("item_plan_amendment", "withdraw")).toEqual({
    party: "operator",
  });
  expect(find("item_late_waiver_request", "apply")).toEqual({
    party: "operator",
  });
  expect(find("item_late_cost_waiver_request", "apply")).toEqual({
    party: "operator",
  });
  expect(find("item_auth", "approve")).toEqual({ party: "programOperator" });
  expect(find("item_disp", "win")).toEqual({ party: "programOperator" });
  expect(find("item_book", "confirm")).toEqual({ party: "operator" });
  expect(find("item_case", "assign")).toEqual({ party: "operator" });
});
