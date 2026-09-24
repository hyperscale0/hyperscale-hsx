import { expect, test } from "bun:test";
import { genericAdapter } from "../../adl/src/boundary-fixture.ts";
import { compile } from "../src/compile.ts";
import { headerManifest } from "../src/headers.ts";
import { standardLibrary } from "./fixtures/std-source.ts";

const source = `program library_audit "Library audit"
use money
use escrow
use marketplace
use financing
use insurance
use lending
use wallet
use cards
use collections
use savings
use reporting
party supplier: business
party inspector: staff role claim_inspector
party investor: business
object item "Item" {
 attach transfer = money.transfer { payer: actor, payee: owner, amount: 750 SAR }
 attach hold = money.hold { payer: actor, payee: owner, amount: 750 SAR }
 attach split = money.split { payer: actor, amount: 750 SAR }
 attach schedule = money.schedule { payer: actor, payee: owner, amount: 750 SAR, count: 3 }
 attach pool = money.pool { payer: actor, payee: owner, target: 1000 SAR, closes: 2027-01-01 }
 attach swap = money.swap { first: actor, second: owner, first_amount: 100 SAR, second_amount: 200 SAR, expires: 2027-01-01 }
 attach payout = money.payout { payer: actor, payee: owner, adapter: "fixture", max_age: 1d }
 attach metered = money.metered { payer: actor, payee: owner, unit_price: 10 SAR }
 attach cov = insurance.cover { holder: actor, broker: supplier, adapter: "insurer", covers: sale }
 attach claim = insurance.claim { cover: cov, inspector: inspector }
 attach sale = escrow.hold { payer: actor, payee: owner }
 attach limits = financing.limits { borrower: actor, per_borrower: 60000 SAR }
 attach ceiling = financing.portfolio_limit { limit: 1500000 SAR }
 attach plan = financing.installments { borrower: actor, capital: operator, months: 3, profit: 2.5%, down_payment: 20%, funds: sale, limits: limits, portfolio: ceiling }
 attach late = financing.late_charge { on: plan, borrower: actor }
 attach line = financing.credit_line { borrower: operator, adapter: "lender", limit: 100000 SAR, expires: 2027-01-01 }
 attach advance = financing.advance { line: line }
 attach case = collections.case { on: plan, agency: supplier }
 attach contact = collections.contact { case: case, agency: supplier }
 attach reminder = collections.reminder { on: plan }
 attach wallet = wallet.balance { holder: investor }
 attach spend = wallet.spend { wallet: wallet, payee: supplier }
 attach round = lending.round { borrower: actor, plan: plan, minimum_ticket: 100 SAR, investor_cap: 100% }
 attach commitment = lending.commitment { round: round, wallet: wallet, investor: investor }
 attach distribution = lending.distribution { round: round, receipt: plan.settlement }
 attach cardholder = cards.cardholder { holder: actor }
 attach card = cards.card { holder: cardholder, spend_limit: 5000 SAR }
 attach authorization = cards.authorization { card: card, merchant: supplier }
 attach transaction = cards.transaction { authorization: authorization }
 attach dispute = cards.dispute { transaction: transaction }
 attach listing = marketplace.listing { seller: owner }
 attach order = marketplace.order { listing: listing, buyer: actor }
 attach reservation = marketplace.reservation { listing: listing, funds: sale, converters: plan, buyer: actor, seller: owner }
 attach circle = savings.circle { contribution: 300 SAR, members: 8, starts: 2027-01-01 }
 attach membership = savings.membership { circle: circle, member: actor }
 attach reports = reporting.portfolio { on: plan }
}`;

// Mutation unreachable-header-state: add an unentered state to any std lifecycle.
// The manifest comparison also fails if a new export lacks a compilation witness.
test("every standard header export is instantiated under the strict compiler", () => {
  const result = compile(source, {
    standardLibrary,
    adapterRegistry: {
      fixture: { adapter: genericAdapter, operation: "boundary.observe" },
    },
  });
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.diagnostics).toEqual([]);
  const attached = new Map(
    [...source.matchAll(/attach (\w+) = ([\w.]+) \{/g)].map((m) => [
      m[2]!,
      m[1]!,
    ]),
  );
  const compiled = new Set(
    result.artifacts.document.objects.flatMap((kind) =>
      kind.attachments.map((a) => a.name),
    ),
  );
  for (const header of headerManifest(standardLibrary).headers)
    for (const item of header.objects) {
      const name = attached.get(item.qualifiedName);
      expect(name, item.qualifiedName).toBeDefined();
      expect(compiled.has(name!), item.qualifiedName).toBe(true);
    }
});

// Mutation own-parameter-shadowing: resolve sibling attachments before own
// bindings in compile.ts and escrow's `dispute.refund_after` names cards.dispute.
test("an own bound parameter shadows a sibling attachment of the same name", () => {
  const program = `program p "P"
use escrow
use cards
party supplier: business
object item "Item" {
 attach sale = escrow.hold { payer: actor, payee: owner }
 attach cardholder = cards.cardholder { holder: actor }
 attach card = cards.card { holder: cardholder, spend_limit: 5000 SAR }
 attach authorization = cards.authorization { card: card, merchant: supplier }
 attach transaction = cards.transaction { authorization: authorization }
 attach dispute = cards.dispute { transaction: transaction }
}`;
  const result = compile(program, { standardLibrary });
  expect(result.diagnostics).toEqual([]);
  const hold = result.artifacts!.document.instruments.find(
    (item) => item.id === "item_sale",
  )!;
  expect(hold.lifecycle.transitions.refund!.from).toEqual(["return_verified"]);
});
