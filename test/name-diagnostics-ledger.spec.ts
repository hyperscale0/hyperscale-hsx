import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { refusal } from "./fixtures/name-diagnostics.ts";

const ledger = `program p "P"
party buyer: business
instrument ledger {
 fields { owner: ref<review>, total: money?, stops: list(date, 3), next: date?, place: integer = 0 }
 lifecycle { states: [open], initial: open }
 action create {}
 action bump { from: open, to: open, input { amount: money }, set: { total: { field: input.amount } } }
 action tidy { from: open, to: open, calculate: [{ target: next, op: at, list: self.stops, position: { field: self.place } }] }
}
instrument review {
 fields { held: account of self, payer: account of buyer, entry: ref<ledger> }
 lifecycle { states: [open], initial: open }
 action create {}
 action sweep { from: open, to: open, invoke: [{ selection: { instrument: ledger, reference: "owner", anchor: self.id, states: [open], limit: 5, where: { place: { literal: 0 } } }, action: bump, input: { amount: { field: self.held.balance } } }] }
 action poke { from: open, to: open, invoke: [{ instrument: ledger, action: create, input: {} }, { reference: self.entry, action: bump, input: { amount: { field: self.payer.balance } } }] }
 action pay { from: open, to: open, requires party.buyer.balance > 0 SAR, moves self.held.balance from self.held to self.payer }
}`;
const ledgerFields = "owner, total, stops, next, place";

test("the ledger program compiles", () => {
  expect(compile(ledger).diagnostics).toEqual([]);
});

// Mutation: drop checkInput from checkPath. UDL says "input.amont must name a money field".
test("a misspelled input names itself and suggests the declared input", () => {
  expect(
    refusal("field: input.amount", "field: input.amont", ledger),
  ).toMatchObject({
    code: "HSX1001",
    at: "input.amont",
    message: "`amont` is not an input of `ledger.bump`. Did you mean `amount`?",
    fix: "Declare `amont` in the input of `ledger.bump`, or use one of amount.",
  });
});

// Mutation: skip checkParty for party paths. UDL says "comparison refers to an undeclared field".
test("a misspelled party path names the party", () => {
  expect(
    refusal("party.buyer.balance", "party.buyr.balance", ledger),
  ).toMatchObject({
    at: "party.buyr.balance",
    message: "`buyr` is not a declared party. Did you mean `buyer`?",
  });
});

// Mutation: report every unresolved path at its root. UDL says "self.held.balanse must name a money field".
test("a misspelled deep segment names the segment after its prefix", () => {
  expect(
    refusal(
      "moves self.held.balance from self.held to self.renter",
      "moves self.held.balanse from self.held to self.renter",
    ),
  ).toMatchObject({
    at: "self.held.balanse",
    message: "`balanse` is not a field of `self.held`. Did you mean `balance`?",
    fix: "Use one of balance, reserved.",
  });
  expect(
    refusal("party.buyer.balance", "party.buyer.balanse", ledger),
  ).toMatchObject({
    at: "party.buyer.balanse",
    message:
      "`balanse` is not a field of `party.buyer`. Did you mean `balance`?",
  });
});

// Mutation: drop checkCall. UDL says "invocation target must name a declared action" or "missing target input amount".
test("a misspelled invoke target names the instrument, action or input", () => {
  expect(
    refusal(
      "{ instrument: ledger, action: create",
      "{ instrument: ledgr, action: create",
      ledger,
    ),
  ).toMatchObject({
    at: "ledgr",
    message: "`ledgr` is not a declared instrument. Did you mean `ledger`?",
    fix: "Name a declared instrument.",
  });
  expect(
    refusal(
      "reference: self.entry, action: bump",
      "reference: self.entry, action: bumpp",
      ledger,
    ),
  ).toMatchObject({
    at: "bumpp",
    message: "`bumpp` is not an action of `ledger`. Did you mean `bump`?",
    fix: "Use one of create, bump, tidy.",
  });
  expect(
    refusal(
      "action: bump, input: { amount:",
      "action: bump, input: { amout:",
      ledger,
    ),
  ).toMatchObject({
    at: "amout",
    message: "`amout` is not an input of `ledger.bump`. Did you mean `amount`?",
  });
});

// Mutation: drop checkSelection. UDL says "unknown selected instrument ledgr" or "unknown selected field plac".
test("a misspelled selection names the instrument or field", () => {
  expect(
    refusal(
      "selection: { instrument: ledger",
      "selection: { instrument: ledgr",
      ledger,
    ),
  ).toMatchObject({
    at: "ledgr",
    message: "`ledgr` is not a declared instrument. Did you mean `ledger`?",
  });
  expect(refusal("where: { place:", "where: { plac:", ledger)).toMatchObject({
    at: "plac",
    message:
      "`plac` is not a field or party of `ledger`. Did you mean `place`?",
    fix: `Use a field declared in \`ledger\` (${ledgerFields}) or a declared party (programOperator, programTax, programFines, programCosts, buyer).`,
  });
  expect(
    refusal('reference: "owner"', 'reference: "ownr"', ledger),
  ).toMatchObject({
    at: '"ownr"',
    message:
      "`ownr` is not a field or party of `ledger`. Did you mean `owner`?",
  });
});

// Mutation: skip the ref target check. UDL says "unknown reference target ledgr" on the field list.
test("a misspelled ref target names itself", () => {
  expect(
    refusal("entry: ref<ledger>", "entry: ref<ledgr>", ledger),
  ).toMatchObject({
    at: "ref<ledgr>",
    message:
      "`ledgr` is not a declared instrument or object. Did you mean `ledger`?",
    fix: "Name a declared instrument or object.",
  });
});

// Mutation: drop "list" from the path keys. UDL says "self.next must name a text field".
test("a misspelled list in a data-form at calculation names itself", () => {
  expect(refusal("list: self.stops", "list: self.stps", ledger)).toMatchObject({
    at: "self.stps",
    message:
      "`stps` is not a field or party of `ledger`. Did you mean `stops`?",
  });
});
