import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";
import { headerManifest } from "../src/headers.ts";

const standardLibrary = {
  source: (name: string) =>
    readFileSync(new URL(`../std/${name}.hsx`, import.meta.url), "utf8"),
};
function refusal(
  source: string,
  message: string,
  fix: string,
  library = standardLibrary,
) {
  const result = compile(source, { standardLibrary: library });
  expect(result.verdict).toBe("invalid");
  const diagnostic = result.diagnostics.find(
    (item) => item.message === message,
  );
  expect(diagnostic?.fix).toBe(fix);
  return { result, diagnostic: diagnostic! };
}

// Mutation: remove dependencies.funds from the header. The attachment refusal disappears.
test("missing conditional funds is one attachment error before field lowering", () => {
  const draft = `program lending_shop "Shop"
use financing
object membership "Membership" {
  attach plan = financing.installments { months: 3, pricing: flat_total, profit_rate: 2%, borrower: actor }
}`;
  const { result, diagnostic } = refusal(
    draft,
    "Attachment `plan` disburses into a hold, but `funds` is not bound.",
    "Bind `funds: checkout` to a funding composition. Choose `disburse_to: seller` to pay a seller on activation, or `disburse_to: borrower` only if the borrower should receive the money directly.",
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(draft.slice(diagnostic.span.start, diagnostic.span.end)).toContain(
    "attach plan",
  );
  expect(diagnostic.related?.[0]?.source).toBe("financing");
  const manifest = headerManifest(standardLibrary, ["financing"]).headers[0]!
    .objects[0]!;
  expect(manifest.dependencies[0]).toMatchObject({
    binding: "funds",
    when: "disburse_to",
    is: "funds",
  });
  expect(
    compile(draft.replace("months: 3", "disburse_to: borrower, months: 3"), {
      standardLibrary,
    }).diagnostics.some((item) => item.message === diagnostic.message),
  ).toBe(false);
});

// Mutation: remove dependencies.seller from the header. A seller plan compiles with nobody to pay.
test("a seller plan without a seller binding is one attachment error", () => {
  const draft = `program pay_later "Pay later"
use financing
party merchant: business
object order "Order" {
  attach plan = financing.installments { months: 4, pricing: flat_total, profit_rate: 0%, borrower: actor, disburse_to: seller }
}`;
  const { result, diagnostic } = refusal(
    draft,
    "Attachment `plan` pays a seller, but `seller` is not bound.",
    "Bind `seller: merchant` to the declared business that receives the principal.",
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(
    compile(
      draft.replace(
        "disburse_to: seller",
        "disburse_to: seller, seller: merchant",
      ),
      {
        standardLibrary,
      },
    ).diagnostics.some((item) => item.message === diagnostic.message),
  ).toBe(false);
});

// Mutation: let an optional party parameter bind a same-named program party.
// Every plan in a program with a seller business would then need a seller.
test("a program party named seller leaves the optional plan seller unset", () => {
  const draft = `program pay_later "Pay later"
use financing
party seller: business
object order "Order" {
  attach limits = financing.limits { borrower: actor, per_borrower: 60000 SAR }
  attach ceiling = financing.portfolio_limit { limit: 1500000 SAR }
  attach plan = financing.installments { months: 4, pricing: flat_total, profit_rate: 0%, borrower: actor, disburse_to: borrower, limits: limits, portfolio: ceiling }
}`;
  const result = compile(draft, { standardLibrary });
  expect(result.diagnostics).toEqual([]);
  const attachments = result.artifacts!.document.objects[0]!.attachments;
  expect(attachments.filter((item) => "seller" in item.parties)).toEqual([]);
  expect(
    compile(draft.replace("disburse_to: borrower", "disburse_to: seller"), {
      standardLibrary,
    }).diagnostics.map((item) => item.message),
  ).toContain("Attachment `plan` pays a seller, but `seller` is not bound.");
});

// Mutation: restore the refusal of parameterized program instruments, or lower
// the fee calculation at instrument level. Each fails to compile this wallet.
test("a program instrument takes party parameters and fees an input amount", () => {
  const result = compile(`program fee_wallet "Fee wallet"
instrument feewallet(holder: party) {
 fields { holder: account of holder, held: account of self }
 lifecycle { states: [pending, active], initial: pending }
 action create {}
 action activate { from: pending, to: active, actor: { party: holder } }
 action topup {
  from: active, to: active, actor: { party: holder }
  input { amount: money }
  moves input.amount from holder to self.held fee { seller: 1% }
 }
}
object wallet "Wallet" {
 attach balance = feewallet { holder: owner, expose topup as top_up }
}`);
  expect(result.diagnostics).toEqual([]);
  const document = result.artifacts!.document;
  expect(document.instruments.map((item) => item.id)).toEqual([
    "wallet_balance",
  ]);
  const topup = document.instruments[0]!.actions.topup!;
  expect(topup.actor).toEqual({ party: "owner" });
  expect(topup.calculate).toContainEqual(
    expect.objectContaining({
      op: "rate",
      base: { field: "input.amount" },
      bps: { literal: 100 },
    }),
  );
  expect(topup.moves.map((move) => "to" in move && move.to)).toEqual([
    "self.held",
    "party.programOperator",
  ]);
});

// Mutation: drop the subject-role branch of checkParty. The fix names a business.
test("a subject role inside a program instrument points to a party parameter", () => {
  refusal(
    `program wallet "Wallet"
instrument purse {
 fields { held: account of self }
 lifecycle { states: [open], initial: open }
 action create { actor: { party: owner } }
}`,
    "`owner` is not a declared party.",
    "Declare a party parameter such as `holder: party` on the instrument, use it here, and bind `holder: owner` where you attach it.",
  );
});

// Mutation: use the scalar type-error branch for names. The runtime rename advice fails.
test("money field binding explains runtime promotion", () => {
  const draft = `program rentals "Rentals"
use money
object rental "Rental" {
 fields { depositAmount: money }
 attach deposit = money.hold { payer: actor, payee: owner, amount: depositAmount }
}`;
  refusal(
    draft,
    "`amount` cannot read `depositAmount` as a tunable. This position accepts a fixed money amount or a runtime amount.",
    "For a varying deposit, omit `amount` and add `rename { amount: depositAmount }`. Use a literal only for a fixed charge.",
  );
  const repaired = compile(
    draft.replace("amount: depositAmount", "rename { amount: depositAmount }"),
    { standardLibrary },
  );
  expect(repaired.diagnostics).toEqual([]);
  expect(
    repaired.artifacts?.document.instruments[0]?.actions.create?.subject
      ?.requirements,
  ).toContainEqual({
    field: { name: "amount", type: "money" },
    objectField: "depositAmount",
  });
});

// Mutation: drop the header percentage metadata. The business-policy explanation fails.
test("percentage late charge cannot silently become a fixed cash charge", () => {
  refusal(
    `program charges "Charges"
use financing
object membership "Membership" {
 attach charge = financing.late_charge { on: [], borrower: actor, fine: 2% }
}`,
    "`financing.late_charge.fine` accepts a fixed amount. It cannot express a percentage of overdue debt.",
    "Use a fixed amount only if that is the intended policy. A percentage charge needs an authored rate calculation; do not approximate it with a cash amount.",
  );
});

// Mutation: omit subject requirements from the unknown-parameter explanation.
test("unknown amount points at the header's actual subject requirement", () => {
  const draft = `program deposits "Deposits"
use escrow
object rental "Rental" {
 fields { deposit: money }
 attach security = escrow.hold { payer: actor, payee: owner, amount: 100 SAR }
}`;
  refusal(
    draft,
    "`escrow.hold` has no `amount` tunable. Its actions require the object's `price` field.",
    "Remove `amount`. To use your object's money field, add `rename { price: deposit }`.",
  );
  expect(
    compile(draft.replace("amount: 100 SAR", "rename { price: deposit }"), {
      standardLibrary,
    }).diagnostics,
  ).toEqual([]);
});

// Mutation: restore 'or declare a party'. The fix no longer distinguishes eligible parties.
test("unbound customer names point at subject identity", () => {
  refusal(
    `program deposits "Deposits"
use money
object rental "Rental" {
 attach deposit = money.hold { payer: customer, payee: owner }
}`,
    "`payer: customer` has no binding. An attached payer must resolve to a subject role or an eligible declared party.",
    "Use `payer: actor` for the initiating customer or `payer: owner` for the object owner. Declare a business for a fixed company counterparty.",
  );
});

// Mutation: drop the person-kind explanation. The next rejection loses the declaration reason.
test("declared person refusal explains attachment identity and authority", () => {
  const { diagnostic } = refusal(
    `program deposits "Deposits"
use money
party customer: person
object rental "Rental" {
 attach deposit = money.hold { payer: customer, payee: owner }
}`,
    "`customer` is a declared person. Attachments resolve customer identity through `owner` or `actor`, rather than a fixed person declaration.",
    "Replace this binding with the appropriate subject role. Use declared businesses for fixed counterparties and permission-bearing staff roles for authorized actions.",
  );
  expect(diagnostic.code).toBe("party_kind_mismatch");
  expect(
    diagnostic.related?.some(
      (location) => location.message === "Declared party customer",
    ),
  ).toBe(true);
});

// Mutation: restore singleton-ID wording or hide candidate names. The scope/candidate witness fails.
test("implicit reference refusal names its parameter, scope and candidates", () => {
  const draft = `program memberships "Memberships"
use financing
object membership "Membership" {
 attach ceiling = financing.portfolio_limit { limit: 100000 SAR }
 attach plan = financing.installments {
  months: 3, pricing: flat_total, profit_rate: 2%, borrower: actor, disburse_to: borrower, portfolio: ceiling
 }
}`;
  refusal(
    draft,
    "Attachment `plan` needs a `limits` binding. No `financing.limits` attachment exists on `membership`.",
    "Attach `financing.limits` to `membership` and bind `limits` to that attachment's name. Choose its borrower limit explicitly.",
  );
  const multiple = draft.replace(
    "attach ceiling",
    `attach first = financing.limits { borrower: actor, per_borrower: 1000 SAR }
 attach second = financing.limits { borrower: actor, per_borrower: 2000 SAR }
 attach ceiling`,
  );
  refusal(
    multiple,
    "Attachment `plan` needs a `limits` binding. Several `financing.limits` attachments match on `membership`: first, second.",
    "Bind `limits` explicitly to one of: first, second.",
  );
});

// Mutation: remove stranded accounts or action-path evidence from the finance prover.
// The operator's settle_refund leaves return_verified whatever the policy says,
// so this escrow drops it to strand the moved refund.
test("refund refusal carries the funded path and owned account with its UDL code", () => {
  const unsettled = {
    source: (name: string) =>
      standardLibrary
        .source(name)
        .replace(/  action settle_return \{[\s\S]*?(?=  action refund \{)/, ""),
  };
  const draft = `program returns "Returns"
use escrow
object rental "Rental" {
 attach deposit = escrow.hold { payer: actor, payee: owner, dispute: { refund_after: delivered } }
}`;
  const { diagnostic } = refusal(
    draft,
    "`deposit` can reach `return_verified` with money in `held`, but no action leaves that state and disposes of the balance.",
    "Restore `refund_after: return_verified`, or move `self.held.balance` out in `verify_return`, or add an action from `return_verified` that does.",
    unsettled,
  );
  expect(diagnostic.code).toBe("UDL4001");
  expect(diagnostic.related?.[0]?.message).toContain(
    "verify_return -> return_verified; owned accounts: held.",
  );
  expect(draft.slice(diagnostic.span.start, diagnostic.span.end)).toBe(
    "delivered",
  );
  expect(
    compile(
      draft.replace("refund_after: delivered", "refund_after: return_verified"),
      { standardLibrary: unsettled },
    ).diagnostics,
  ).toEqual([]);
  expect(compile(draft, { standardLibrary }).diagnostics).toEqual([]);
});

// Mutation: restore field-removal advice or change the eight-column boundary.
test("column limit preserves the nine-field object model", () => {
  const draft = `program lists "Lists"
object item "Item" {
 fields { a: text, b: text, c: text, d: text, e: text, f: text, g: text, h: text, i: text }
 columns: [a, b, c, d, e, f, g, h, i]
}`;
  refusal(
    draft,
    "The object list selects 9 columns; this release supports 8. The object may retain all its fields.",
    "Remove one name from `columns`, not from `fields`.",
  );
  const repaired = compile(draft.replace("g, h, i]", "g, h]"));
  expect(repaired.artifacts?.document.objects[0]?.fields).toHaveLength(9);
});

// Mutation: read subject rows through entries(). Repeated when branches in disburse
// then hide the unknown tunable behind a duplicate branch error.
test("an unknown financing tunable names itself", () => {
  const result = compile(
    `program loans "Loans"
use financing
object loan "Loan" {
  attach plan = financing.installments { months: 12, profit: 18%, borrower: actor, disburse_to: borrower }
}`,
    { standardLibrary },
  );
  expect(result.diagnostics.map((item) => item.message)).toEqual([
    "unknown tunable profit",
  ]);
});
