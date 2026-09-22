import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";
import { headerManifest } from "../src/headers.ts";

const standardLibrary = {
  source: (name: string) =>
    readFileSync(new URL(`../std/${name}.hsx`, import.meta.url), "utf8"),
};
function refusal(source: string, message: string, fix: string) {
  const result = compile(source, { standardLibrary });
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
  attach plan = financing.installments { months: 3, profit: 2%, borrower: actor }
}`;
  const { result, diagnostic } = refusal(
    draft,
    "Attachment `plan` disburses into a hold, but `funds` is not bound.",
    "Bind `funds: sale` to an escrow attachment. Choose `disburse_to: borrower` only if the borrower should receive the money directly.",
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

// Mutation: restore the program-records wording. The message and usable fix fail.
test("local parameterized instruments explain the unavailable instantiation path", () => {
  refusal(
    `program hiring "Hiring"
instrument review(reviewer: party) {
 lifecycle { states: [submitted, accepted], initial: submitted }
 action create {}
 action accept { from: submitted, to: accepted, actor: { party: reviewer } }
}`,
    "This compiler cannot instantiate a parameterized instrument declared inside a program.",
    "For this version, specialize the instrument with fixed bindings and remove its parameters. Custom reusable headers require a host-supplied library.",
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
    "`escrow.hold` has no `amount` tunable. Its funding action requires the object's `price` field.",
    "Remove `amount`. To use your deposit field, add `rename { price: deposit }`.",
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
  months: 3, profit: 2%, borrower: actor, disburse_to: borrower, portfolio: ceiling
 }
}`;
  refusal(
    draft,
    "Attachment `plan` needs a `limits` binding. No `financing.limits` attachment exists on `membership`.",
    "Declare a limits attachment and bind `limits: allowance`. Choose its borrower limit explicitly.",
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
test("refund refusal carries the funded path and owned account with its UDL code", () => {
  const draft = `program returns "Returns"
use escrow
object rental "Rental" {
 attach deposit = escrow.hold { payer: actor, payee: owner, dispute: { refund_after: delivered } }
}`;
  const { diagnostic } = refusal(
    draft,
    "`deposit` can reach `return_verified` with money in `held`, but no action leaves that state and disposes of the balance.",
    "Restore `refund_after: return_verified`, or author a complete refund path for every reachable funded state.",
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
      { standardLibrary },
    ).diagnostics,
  ).toEqual([]);
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
