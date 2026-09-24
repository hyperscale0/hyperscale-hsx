import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { refusal, rental } from "./fixtures/name-diagnostics.ts";

const parties = "programOperator, programTax, renter";
const fields = "renter, held, amount, lateFee, dueAt, refund";
const states = "pending, funded, returned, cancelled";

// Mutation: drop the root message in checkPath. UDL reports a JSON path on each instrument copy.
test("a misspelled field names itself and suggests the declared field", () => {
  expect(
    refusal(
      "moves self.amount from self.renter",
      "moves self.amont from self.renter",
    ),
  ).toMatchObject({
    code: "HSX1001",
    stage: "check",
    at: "self.amont",
    message:
      "`amont` is not a field or party of `deposit`. Did you mean `amount`?",
    fix: `Use a field declared in \`deposit\` (${fields}) or a declared party (${parties}).`,
  });
  expect(
    refusal(
      "moves self.held.balance from self.held to self.renter",
      "moves self.held.balance from self.hel to self.renter",
    ),
  ).toMatchObject({
    at: "self.hel",
    message: "`hel` is not a field or party of `deposit`. Did you mean `held`?",
  });
  expect(
    refusal(
      "moves self.amount from self.renter to self.held",
      "moves self.amount from self.renter to renterx",
    ),
  ).toMatchObject({
    at: "renterx",
    message:
      "`renterx` is not a field or party of `deposit`. Did you mean `renter`?",
  });
});

// Mutation: skip checkParty on actor parties. UDL says "actor names an undeclared party" without the name.
test("a misspelled actor party names itself and suggests the declared party", () => {
  expect(
    refusal(
      "action cancel { from: pending, to: cancelled, actor: { party: renter } }",
      "action cancel { from: pending, to: cancelled, actor: { party: rentr } }",
    ),
  ).toMatchObject({
    at: "rentr",
    message: "`rentr` is not a declared party. Did you mean `renter`?",
    fix: `Declare it with \`party rentr: business\`, or name a declared party (${parties}).`,
  });
});

// Mutation: skip requires in the name walk. UDL says "comparison refers to an undeclared field".
test("a misspelled field in requires names itself", () => {
  expect(
    refusal(
      "requires self.dueAt > self.now",
      "requires self.dueAtt > self.now",
    ),
  ).toMatchObject({
    at: "self.dueAtt",
    message:
      "`dueAtt` is not a field or party of `deposit`. Did you mean `dueAt`?",
  });
  expect(
    refusal("requires self.dueAt > self.now", "requires self.dueAt > self.nw"),
  ).toMatchObject({
    at: "self.nw",
    message: "`nw` is not a field or party of `deposit`. Did you mean `now`?",
  });
});

// Mutation: skip set keys or set values. UDL names neither the key nor the source.
test("a misspelled field in set names itself", () => {
  const review = `program p "P"
instrument review {
 fields { note: text?, label: text = "x" }
 lifecycle { states: [open], initial: open }
 action create {}
 action record { from: open, to: open, set: { note: { field: self.label } } }
}`;
  expect(compile(review).diagnostics).toEqual([]);
  expect(refusal("set: { note:", "set: { nte:", review)).toMatchObject({
    at: "nte",
    message: "`nte` is not a field or party of `review`. Did you mean `note`?",
  });
  expect(
    refusal("field: self.label", "field: self.lable", review),
  ).toMatchObject({
    at: "self.lable",
    message:
      "`lable` is not a field or party of `review`. Did you mean `label`?",
  });
});

// Mutation: stop checking calculate targets in the name walk. UDL reports the target as `self.refnd`.
test("a misspelled field in calculate names itself", () => {
  expect(refusal("target: refund", "target: refnd")).toMatchObject({
    at: "refnd",
    message:
      "`refnd` is not a field or party of `deposit`. Did you mean `refund`?",
  });
  expect(
    refusal(
      "base: { field: self.held.balance }",
      "base: { field: self.hed.balance }",
    ),
  ).toMatchObject({
    at: "self.hed.balance",
    message: "`hed` is not a field or party of `deposit`. Did you mean `held`?",
  });
});

// Mutation: skip invariants in the name walk. UDL says "comparison refers to an undeclared field".
test("a misspelled field in invariants names itself", () => {
  const invariant = (field: string) =>
    `  invariants: [{ kind: compare, left: { field: ${field} }, operator: ">", right: { literal: "0" } }]\n  lifecycle {`;
  const guarded = rental.replace("  lifecycle {", invariant("self.amount"));
  expect(compile(guarded).diagnostics).toEqual([]);
  expect(
    refusal(invariant("self.amount"), invariant("self.amont"), guarded),
  ).toMatchObject({
    at: "self.amont",
    message:
      "`amont` is not a field or party of `deposit`. Did you mean `amount`?",
  });
});

// Mutation: drop "reference" from the path keys. UDL reports the reference on the whole instrument.
test("a misspelled reference in invoke names itself", () => {
  const review = `program p "P"
instrument review {
 lifecycle { states: [open, closed], initial: open }
 action create {}
 action close { from: open, to: closed }
 action record { from: open, to: open, invoke: [{ reference: self.id, action: close, input: {} }] }
}`;
  expect(compile(review).diagnostics).toEqual([]);
  expect(
    refusal("reference: self.id", "reference: self.idd", review),
  ).toMatchObject({
    at: "self.idd",
    message: "`idd` is not a field or party of `review`. Did you mean `id`?",
  });
});

// Mutation: drop "at" from the path keys. UDL says "self.dueAtt must name a date field".
test("a misspelled field in a due or deadline instant names itself", () => {
  expect(
    refusal("deadline: { at: self.dueAt }", "deadline: { at: self.dueAtt }"),
  ).toMatchObject({
    at: "self.dueAtt",
    message:
      "`dueAtt` is not a field or party of `deposit`. Did you mean `dueAt`?",
  });
  expect(
    refusal("due: { at: self.dueAt }", "due: { at: self.duAt }"),
  ).toMatchObject({
    at: "self.duAt",
    message:
      "`duAt` is not a field or party of `deposit`. Did you mean `dueAt`?",
  });
});

// Mutation: drop "fields" from the path keys. UDL says "unknown identity field".
test("a misspelled field in unique names itself", () => {
  const unique = rental.replace(
    "requires self.dueAt > self.now",
    'requires self.dueAt > self.now; requires unique "rental" on [self.renter]',
  );
  expect(compile(unique).diagnostics).toEqual([]);
  expect(
    refusal("on [self.renter]", "on [self.renterr]", unique),
  ).toMatchObject({
    at: "self.renterr",
    message:
      "`renterr` is not a field or party of `deposit`. Did you mean `renter`?",
  });
});

// Mutation: drop checkState. UDL reports an invalid transition and every unreachable state, twice.
test("a misspelled state is one error at the state name", () => {
  expect(
    refusal("from: pending, to: funded", "from: pendng, to: funded"),
  ).toMatchObject({
    at: "pendng",
    message: "`pendng` is not a state of `deposit`. Did you mean `pending`?",
    fix: `Use one of ${states}, or add \`pendng\` to \`lifecycle.states\`.`,
  });
  expect(
    refusal("from: pending, to: funded", "from: pending, to: fundd"),
  ).toMatchObject({
    at: "fundd",
    message: "`fundd` is not a state of `deposit`. Did you mean `funded`?",
  });
  expect(refusal("initial: pending", "initial: draft")).toMatchObject({
    at: "draft",
    message: "`draft` is not a state of `deposit`.",
    fix: `Use one of ${states}, or add \`draft\` to \`lifecycle.states\`.`,
  });
});

// Mutation: remove distinct(). The attached copy and the standalone copy both report the typo.
test("an instrument attached before its declaration reports a typo once", () => {
  const declaration = rental.slice(
    rental.indexOf("instrument deposit {"),
    rental.indexOf("object rental"),
  );
  const attachedFirst = rental
    .replace(declaration, "")
    .replace("hide deposit.create", `${declaration}hide deposit.create`);
  expect(compile(attachedFirst).diagnostics).toEqual([]);
  expect(
    refusal(
      "from: pending, to: funded",
      "from: pendng, to: funded",
      attachedFirst,
    ),
  ).toMatchObject({ at: "pendng" });
});

// Mutation: fail at the resolved value instead of the authored header expression.
test("a typo inside a header points at the header source", () => {
  const header = `header custom
instrument review(payer: party) {
 fields { held: account of self, amount: money = 10 SAR }
 lifecycle { states: [open, paid], initial: open }
 action create { actor: { party: payer } }
 action pay { from: open, to: paid, actor: { party: payer }, moves self.amont from payer to self.held }
}`;
  const result = compile(
    'program p "P"\nuse custom\nparty buyer: business\nreview = custom.review { payer: buyer }',
    { standardLibrary: { source: () => header } },
  );
  expect(result.diagnostics).toHaveLength(1);
  const diagnostic = result.diagnostics[0]!;
  expect(diagnostic).toMatchObject({
    source: "custom",
    line: 6,
    message:
      "`amont` is not a field or party of `review`. Did you mean `amount`?",
  });
  expect(header.slice(diagnostic.span.start, diagnostic.span.end)).toBe(
    "self.amont",
  );
});
