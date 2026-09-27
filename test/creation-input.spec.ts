import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

const wallet = `program p "P"
use wallet
use money
object member "Member" {
  attach wallet = wallet.balance { holder: owner, expose create as open_wallet }
  attach spend = wallet.spend { wallet: wallet, payee: operator, holder: owner, expose create as spend }
  attach fee = money.transfer { payer: owner, payee: operator, expose create as charge_fee }
}`;

function lowered(source: string) {
  const result = compile(source);
  expect(result.diagnostics).toEqual([]);
  return result.artifacts!.document;
}
const instrument = (document: ReturnType<typeof lowered>, id: string) =>
  document.instruments.find((item) => item.id === id)!;

// R125-208. Mutation: lower unrenamed runtime fields to create subject
// requirements again; both attachments then share the object's amount.
test("runtime creation values are agreement input, not shared object metadata", () => {
  const document = lowered(wallet);
  expect(document.objects[0]!.fields.map((field) => field.name)).toEqual([]);
  for (const [id, names] of [
    ["member_spend", ["amount", "expiresAt"]],
    ["member_fee", ["amount"]],
  ] as const) {
    const create = instrument(document, id).actions.create!;
    expect(create.subject).toBeUndefined();
    expect(
      create.input
        .filter((field) => !field.optional)
        .map((field) => field.name),
    ).toEqual([...names]);
  }
  // Later actions keep reading the agreement's own field.
  expect(
    instrument(document, "member_fee").actions.pay!.moves[0],
  ).toMatchObject({ amount: { field: "self.amount" } });
});

test("an explicit rename keeps a creation value as shared object metadata", () => {
  const document = lowered(
    wallet.replace(
      "attach fee = money.transfer { payer: owner,",
      "attach fee = money.transfer { rename { amount: feeAmount }, payer: owner,",
    ),
  );
  const create = instrument(document, "member_fee").actions.create!;
  expect(create.input.map((field) => field.name)).not.toContain("amount");
  expect(create.subject!.requirements).toMatchObject([
    { field: { name: "amount" }, objectField: "feeAmount" },
  ]);
  expect(document.objects[0]!.fields.map((field) => field.name)).toEqual([
    "feeAmount",
  ]);
});

// Mutation: share a required creation field with an authored object field of
// the same name; a fee created without its own amount then inherits the
// amount a spend stored on the member.
test("an authored object field of the same name does not share a creation value", () => {
  const document = lowered(
    wallet.replace(
      'object member "Member" {',
      'object member "Member" {\n  fields { amount: money }',
    ),
  );
  for (const id of ["member_spend", "member_fee"]) {
    const create = instrument(document, id).actions.create!;
    expect(create.subject).toBeUndefined();
    expect(create.input.map((field) => field.name)).toContain("amount");
  }
});

// Mutation: drop the implicit-creation guard; pay_fee then creates with no amount.
test("an attachment that needs creation input must expose its create", () => {
  const hidden = wallet.replace(
    "expose create as charge_fee",
    "expose pay as pay_fee",
  );
  const [diagnostic] = compile(hidden).diagnostics;
  expect(diagnostic).toMatchObject({
    code: "HSX1001",
    message:
      "fee starts from pay_fee, but its create needs amount and is not exposed",
  });
  expect(
    hidden.slice(diagnostic!.span.start, diagnostic!.span.end),
  ).toStartWith("attach fee");
  lowered(
    hidden.replace("expose pay", "expose create as charge_fee, expose pay"),
  );
  lowered(
    hidden.replace(
      "{ payer: owner,",
      "{ rename { amount: amount }, payer: owner,",
    ),
  );
});

test("a rename of a record field names the record instead of promising a binding", () => {
  const [diagnostic] = compile(`program p "P"
use insurance
object trip "Trip" {
  attach cover = insurance.cover {
    holder: owner, adapter: "conformance_boundary", claim_limit: 1000 SAR
    rename { premium: price }
    expose create as quote_cover
  }
}`).diagnostics;
  expect(diagnostic).toMatchObject({
    code: "subject_field_unknown",
    message:
      "rename source 'premium' belongs to the slice record of insurance.cover; rename binds only fields of insurance.cover itself",
  });
});

// R125-225. Mutation: skip instrument references in the creation loop; the
// write-off request and the late charge then cannot name one slice or plan.
test("creation offers each agreement reference as an optional selector", () => {
  const document = lowered(`program p "P"
use financing
object purchase "Purchase" {
  fields { price: money }
  attach limits = financing.limits { borrower: owner, per_borrower: 60000 SAR, expose create as limits }
  attach ceiling = financing.portfolio_limit { limit: 1500000 SAR, expose create as ceiling }
  attach plan = financing.installments {
    borrower: owner, capital: operator, months: 4, pricing: flat_total, profit_rate: 4%
    disburse_to: borrower, limits: limits, portfolio: ceiling, expose create as finance
  }
  attach late = financing.late_charge {
    on: plan, borrower: owner, fines_to: operator, costs_to: operator, fine: 50 SAR
    expose create as propose_late_fee
  }
}
expose purchase.plan.write_off_request.create as request_write_off`);
  const selectors = (id: string) =>
    instrument(document, id)
      .actions.create!.input.filter((field) => field.type === "ref")
      .map((field) => [field.name, field.optional]);
  expect(selectors("purchase_plan_write_off_request")).toEqual([
    ["plan", true],
    ["overdueSlice", true],
  ]);
  // late_charge declares slice itself; the compiler adds only plan.
  expect(selectors("purchase_late")).toEqual([
    ["slice", true],
    ["plan", true],
  ]);
});
