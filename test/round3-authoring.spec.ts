import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";
import { runCli } from "../src/cli.ts";

const standardLibrary = {
  source: (name: string) =>
    readFileSync(new URL(`../std/${name}.hsx`, import.meta.url), "utf8"),
};
const build = (source: string) => compile(source, { standardLibrary });
const errors = (source: string) =>
  build(source).diagnostics.map((item) => `${item.code} ${item.message}`);

// Mutation: drop the kin filter from matchable. The cash escrow's refund
// selects the other object's plan and fails UDL2002.
test("an unfinanced escrow beside a financed one only selects its own plans", () => {
  const result = build(`program shop "Shop"
use escrow
use financing
object cash_sale "Cash sale" {
  fields { title: text, price: money }
  attach sale = escrow.hold { payer: owner, expose create as create_payment, expose refund as refund_buyer }
}
object financed_sale "Financed sale" {
  fields { title: text, price: money }
  attach sale = escrow.hold { payer: owner, expose create as create_financed_payment }
  attach allowance = financing.limits { borrower: owner, per_borrower: 20000 SAR, expose create as create_allowance }
  attach budget = financing.portfolio_limit { limit: 2000000 SAR, expose create as create_budget }
  attach plan = financing.installments { borrower: owner, capital: operator, funds: sale, limits: allowance, portfolio: budget, months: 4, pricing: flat_total, profit_rate: 4%, expose create as finance }
}`);
  expect(result.diagnostics).toEqual([]);
  const instruments = result.artifacts!.document.instruments;
  const cash = instruments.find((item) => item.id === "cash_sale_sale")!;
  expect(cash.actions.refund!.requires).toContainEqual({
    kind: "compare",
    left: { literal: 0 },
    operator: "==",
    right: { literal: 0 },
  });
  const financed = instruments.find(
    (item) => item.id === "financed_sale_sale",
  )!;
  expect(
    financed.actions.refund!.requires.some(
      (rule) =>
        rule.kind === "aggregate" &&
        [rule.selection.instrument].flat().includes("financed_sale_plan"),
    ),
  ).toBe(true);
});

const trip = (selection: string) => `program trips "Trips"
instrument trip(traveller: party) {
  summary: "A dated trip."
  fields { traveller: account of traveller, departure: date, returning: date, note: text? }
  lifecycle { states: [booked], initial: booked }
  invariants count of { instrument: current(), ${selection}, states: [booked], limit: 366 } <= 1
  action create { subject { departure: date, returning: date }, actor: { party: traveller } }
}
object holiday "Holiday" {
  fields { departure: date, returning: date }
  columns: [departure, returning]
  attach trip = trip { traveller: owner, expose create as book }
}`;

// Mutation: remove overlaps from the UDL selection schema, or accept a text
// period field. The first program stops compiling or the second one does.
test("a selection keeps rows whose period overlaps a range, scoped to a party", () => {
  const result = build(
    trip(
      'reference: "traveller", anchor: self.traveller, overlaps: { start: departure, end: returning, from: { field: self.departure }, until: { field: self.returning } }',
    ),
  );
  expect(result.diagnostics).toEqual([]);
  expect(
    result.artifacts!.document.instruments[0]!.invariants![0],
  ).toMatchObject({
    selection: {
      reference: "traveller",
      anchor: "self.traveller",
      overlaps: {
        start: "departure",
        end: "returning",
        from: { field: "self.departure" },
        until: { field: "self.returning" },
      },
    },
  });
  expect(
    errors(
      trip(
        'reference: "traveller", anchor: self.traveller, overlaps: { start: departure, end: note, from: { field: self.departure }, until: { field: self.returning } }',
      ),
    ).join("\n"),
  ).toContain(
    "selection overlaps requires start and end date fields on every selected instrument",
  );
});

// Mutation: let `cap` after a value always start the capped operator. The
// next entry named cap becomes a parse error.
test("a field named cap on its own line is a field, not the cap operator", () => {
  const result = build(`program capped "Capped"
instrument guarantee() {
  fields {
    amount: money
    cap: money = 60 SAR
  }
  lifecycle { states: [open], initial: open }
  action create { subject { amount: money }, actor: { party: programOperator }, requires self.amount <= self.cap }
}`);
  expect(result.diagnostics).toEqual([]);
});

// Mutation: restore the fixed `allowance` repair. The fix names an unrelated attachment.
test("a missing sibling names the template, the object and where it does exist", () => {
  const [diagnostic] = build(`program coop "Coop"
use lending
use financing
use wallet
object member_loan "Member loan" {
  fields { purpose: text, price: money }
  attach allowance = financing.limits { borrower: owner, per_borrower: 30000 SAR }
  attach budget = financing.portfolio_limit { limit: 5000000 SAR }
  attach loan = financing.installments { borrower: owner, capital: operator, months: 12, pricing: amortizing, profit_rate: 9%, disburse_to: borrower, limits: allowance, portfolio: budget }
  attach funding = lending.round { borrower: owner, plan: loan }
}
object investment "Investment" {
  fields { note: text }
  attach purse = wallet.balance { holder: owner }
  attach stake = lending.commitment { round: object(lending.round), wallet: purse, investor: owner }
}`).diagnostics;
  expect(diagnostic!.fix).toBe(
    "Attach `lending.commitment` to `member_loan` and bind `commitments` to that attachment's name. Choose `round`, `wallet` explicitly. `investment.stake` is on another object, which this binding cannot reach.",
  );
});

// Mutation: remove moneyPath from move lowering. The UDL validator reports
// the attach line and asks for a subject role binding instead.
test("operator in a custom instrument's move points at the move and suggests programOperator", () => {
  const source = `program tours "Tours"
instrument trip(traveller: party) {
  summary: "Pay once."
  fields { traveller: account of traveller, held: account of self, price: money = subject.price }
  lifecycle { states: [booked, paid, completed], initial: booked }
  action create { subject { price: money }, actor: { party: traveller } }
  action pay { from: booked, to: paid, actor: { party: traveller }, moves self.price from traveller to self.held }
  action complete { from: paid, to: completed, actor: { party: traveller }, moves self.held.balance from self.held to operator }
}
object holiday "Holiday" {
  fields { price: money }
  attach trip = trip { traveller: owner, expose create as book }
}`;
  const [diagnostic] = build(source).diagnostics;
  expect(diagnostic).toMatchObject({
    code: "subject_party_unbound",
    message: "`operator` has no money account in `trip`",
    fix: "Use `programOperator` for the company's own account.",
    line: 8,
  });
  expect(source.slice(diagnostic!.span.start, diagnostic!.span.end)).toBe(
    "operator",
  );
});

// Mutation: drop the period guard in the CLI. A message that ends in a
// period prints two.
test("the CLI prints one period between a message and its fix", async () => {
  const lines: string[] = [];
  await runCli(["check", "p.hsx"], {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    readFile: async () => `program p "P"
use financing
object membership "Membership" {
  attach plan = financing.installments { months: 3, pricing: flat_total, profit_rate: 2%, borrower: actor, disburse_to: borrower }
}`,
    writeFile: async () => {},
  });
  expect(lines.join("\n")).not.toContain("..");
});

// Mutation: drop reachedParty. The source party of a move out of
// self.plan.borrower is unknown and the move loses its economics.
test("economics may name a party reached through a sibling reference", () => {
  const result = build(`program shop "Shop"
use escrow
use financing
instrument late_fee(on: ref<financing.installments>) {
  summary: "A late fee on one plan."
  fields { plan: ref<on>, lateFees: account(programOperator, cash, "late_fees"), fee: money = 60 SAR }
  lifecycle { states: [proposed, assessed], initial: proposed }
  action create { actor: { party: programOperator } }
  action assess {
    from: proposed, to: assessed, actor: { party: programOperator }
    moves self.fee from self.plan.borrower to self.lateFees economics { purpose: earning, sourceParty: borrower }
  }
}
object purchase "Purchase" {
  fields { price: money }
  attach sale = escrow.hold { payer: owner, payee: operator }
  attach allowance = financing.limits { borrower: owner, per_borrower: 20000 SAR }
  attach budget = financing.portfolio_limit { limit: 2000000 SAR }
  attach plan = financing.installments { borrower: owner, capital: operator, funds: sale, limits: allowance, portfolio: budget, months: 4, pricing: flat_total, profit_rate: 4% }
  attach fee = late_fee { on: plan, expose create as propose_late_fee }
}`);
  expect(result.diagnostics).toEqual([]);
  const document = result.artifacts!.document;
  expect(
    document.instruments.find((item) => item.id === "purchase_fee")!.actions
      .assess!.moves[0]!.economics,
  ).toEqual({ purpose: "earning", sourceParty: "owner" });
  expect(
    document.objects[0]!.attachments.find((item) => item.name === "fee")!
      .parties,
  ).toEqual({ borrower: { role: "owner" } });
});
