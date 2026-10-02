import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

const program = `program p "All"
use money
use escrow
use purchase
use financing
use insurance
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
  attach mandate = money.mandate { payer: actor, payee: owner }
  attach metered = money.metered { payer: actor, payee: owner, unit_price: 10 SAR }
  attach cov = insurance.cover { holder: actor, adapter: "motor_insurer", covers: sale }
  attach clm = insurance.claim { cover: cov, inspector: inspector }
  attach sale = escrow.hold { funding: { controllers: [checkout], reference: "funds", blocking_states: [active] }, payer: actor, payee: owner }
  attach limits = financing.limits { borrower: actor, per_borrower: 60000 SAR }
  attach ceiling = financing.portfolio_limit { limit: 1500000 SAR }
  attach checkout = purchase.checkout { plans: plan, funds: sale, borrower: actor, capital: operator }
  attach plan = financing.installments { borrower: actor, capital: operator, share: 25%, months: 3, pricing: flat_total, profit_rate: 2.5%, down_payment: 20%, funds: checkout, limits: limits, portfolio: ceiling }
  attach late = financing.late_charge { on: plan, borrower: actor, fines_to: operator, costs_to: operator }
  attach case = collections.case { on: plan, agency: supplier, capital: operator }
  attach inv_wallet = wallet.balance { holder: investor }
  attach spend = wallet.spend { wallet: inv_wallet, payee: supplier, holder: investor }
  attach round = lending.round { borrower: actor, plan: plan, minimum_ticket: 100 SAR, investor_cap: 100% }
  attach commit = lending.commitment { round: round, wallet: inv_wallet, investor: investor }
  attach dist = lending.distribution { round: round, receipt: plan.settlement, fee: 0%, tax: 0% }
  attach cardholder = cards.cardholder { holder: actor }
  attach card = cards.card { holder: cardholder, person: actor, spend_limit: 5000 SAR }
  attach auth = cards.authorization { card: card, merchant: supplier }
  attach txn = cards.transaction { authorization: auth }
  attach disp = cards.dispute { transaction: txn }
}`;

// The engine's std authority spec refuses a stranger every
// actor-named std action. This pins which party each of these names.
test("standard library money actions name the accountable party", () => {
  const result = compile(program);
  expect(result.diagnostics).toEqual([]);
  const doc = result.artifacts!.document;
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
  expect(find("item_case", "assign")).toEqual({ party: "operator" });
  // Mutation: drop the actor from any of these. A customer or seller could
  // then approve credit or lift an operator's freeze or suspension.
  for (const [id, action] of [
    ["item_limits", "approve"],
    ["item_ceiling", "approve"],
    ["item_cardholder", "activate"],
    ["item_cardholder", "suspend"],
    ["item_cardholder", "resume"],
    ["item_inv_wallet", "freeze"],
    ["item_inv_wallet", "unfreeze"],
  ])
    expect(find(id!, action!)).toEqual({ party: "programOperator" });
});

// Mutation: drop the party actor from any of these creates, or from the credit
// line or advance actions. A customer could not start the agreement on another
// party's record, or anyone who reaches the record could draw on the facility.
test("each party that starts an agreement can enter through its create", () => {
  const result = compile(`program entry "Entry"
use escrow
use purchase
use financing
use insurance
use wallet
use savings
object item "Item" {
  entryActions: [pay, cap, finance, open_line, cover, open_wallet, join]
  fields { price: money }
  attach sale = escrow.hold { funding: { controllers: [checkout], reference: "funds", blocking_states: [active] }, payer: actor, payee: owner, expose create as pay }
  attach limits = financing.limits { borrower: actor, per_borrower: 60000 SAR, expose create as cap }
  attach ceiling = financing.portfolio_limit { limit: 1500000 SAR }
  attach checkout = purchase.checkout { plans: plan, funds: sale, borrower: actor, capital: operator }
  attach plan = financing.installments { borrower: actor, capital: operator, months: 3, pricing: flat_total, profit_rate: 2.5%, funds: checkout, limits: limits, portfolio: ceiling, expose create as finance }
  attach line = financing.credit_line { borrower: actor, adapter: "bank", limit: 1000 SAR, expires: 2027-12-31, expose create as open_line }
  attach draw = financing.advance { line: line, borrower: actor }
  attach cov = insurance.cover { holder: actor, adapter: "insurer", expose create as cover }
  attach purse = wallet.balance { holder: actor, expose create as open_wallet }
  attach circle = savings.circle { contribution: 100 SAR, members: 5, starts: 2027-01-01 }
  attach seat = savings.membership { circle: circle, member: actor, expose create as join }
}`);
  expect(result.diagnostics).toEqual([]);
  const doc = result.artifacts!.document;
  const actor = (id: string, action: string) =>
    doc.instruments.find((i) => i.id === id)?.actions[action]?.actor;
  for (const [id, action] of [
    ["item_line", "close"],
    ["item_draw", "create"],
    ["item_draw", "draw"],
    ["item_draw", "repay"],
    ["item_draw", "cancel"],
  ])
    expect(actor(id!, action!)).toEqual({ party: "actor" });
});
