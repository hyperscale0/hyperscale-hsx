import { validateUdl } from "@hyperscale0/udl";
import { genericAdapter } from "../../adl/src/boundary-fixture.ts";
import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

const transfer = `program shop "Shop"
use money
party buyer: person
party seller: business
sale = money.transfer { payer: buyer, payee: seller, amount: 750 SAR }
`;

test("money literals preserve minor units and reject sub-minor precision", () => {
  const good = compile(transfer);
  const bad = compile(transfer.replace("750 SAR", "750.001 SAR"));
  expect([
    good.artifacts?.document.instruments[0]?.fields[0],
    bad.verdict,
  ]).toEqual([{ name: "amount", type: "money", value: "75000" }, "invalid"]);
});

test("unknown tunables refuse at the founder's declaration", () => {
  const result = compile(
    transfer.replace("amount: 750 SAR", "ammount: 750 SAR"),
  );
  expect([
    result.artifacts,
    result.diagnostics[0]?.line,
    result.diagnostics[0]?.message,
  ]).toEqual([undefined, 5, "unknown tunable ammount"]);
});

test("exposure renames one action without granting authority", () => {
  const result = compile(
    transfer + "expose sale.pay as checkout\nhide sale.cancel\n",
  );
  const actions = result.artifacts?.document.instruments[0]?.actions;
  expect([
    actions?.pay?.publicAction,
    actions?.pay?.actor,
    actions?.cancel?.publicAction,
  ]).toEqual(["checkout", { party: "buyer" }, undefined]);
});

const pool = `program pool_test "Pool"
use money
party payer: person
party payee: business
pool = money.pool { payer: payer, payee: payee, target: 1000 SAR, closes: 2026-12-31 }
`;

test("clock and parent actions carry no public name and cannot be exposed", () => {
  const document = compile(pool).artifacts?.document;
  const actions = Object.fromEntries(
    document?.instruments.flatMap((instrument) =>
      Object.entries(instrument.actions).map(([name, action]) => [
        `${instrument.id}.${name}`,
        action.publicAction ?? null,
      ]),
    ) ?? [],
  );
  expect(actions["pool.fail"]).toBeNull();
  expect(actions["pool_contribution.refund"]).toBeNull();
  expect(actions["pool.pay"]).toBe("payPool");
  const exposed = compile(pool + "expose pool.fail as close\n");
  expect(exposed.verdict).toBe("invalid");
  expect(exposed.diagnostics[0]?.message).toContain("runs on the clock");
});

test("expression clauses preserve ordered UDL and refuse a missing move endpoint", () => {
  const prefix = `program invoice "Invoice"
party buyer: person
party seller: business
instrument invoice {
 fields { amount: money = 100 SAR }
 lifecycle { states: [paid], initial: paid }
 action create { `;
  const expressions = `requires self.amount == 100 SAR; moves self.amount from buyer to seller`;
  const objects = `requires: [{ kind: "compare", left: { field: self.amount }, operator: "==", right: { literal: "10000" } }]
 moves: [{ amount: self.amount, from: buyer, to: seller }]`;
  const expression = compile(prefix + expressions + " } }");
  const object = compile(prefix + objects + " } }");
  const mutation = compile(
    prefix + expressions.replace("to seller", "seller") + " } }",
  );
  expect([
    expression.verdict,
    expression.artifacts?.document,
    mutation.verdict,
  ]).toEqual(["valid", object.artifacts?.document, "invalid"]);
});

// Mutation: drop economics while lowering the generic move record.
test("authored move economics survives compilation into the Build document", () => {
  const source = `program invoice "Invoice"
party buyer: person
party seller: business
instrument invoice {
 fields { amount: money = 100 SAR }
 lifecycle { states: [paid], initial: paid }
 action create {
  moves self.amount from buyer to seller economics { purpose: earning, sourceParty: buyer }
 }
}`;
  const compiled = compile(source);
  expect(compiled.verdict).toBe("valid");
  expect(
    compiled.artifacts?.document.instruments[0]?.actions.create?.moves[0]
      ?.economics,
  ).toEqual({
    purpose: "earning",
    sourceParty: "buyer",
  });
});

test("enum branches keep only the chosen ordered moves", () => {
  const standardLibrary = {
    source: (name: string) =>
      name === "choice"
        ? `header choice
instrument transfer(direction: enum(forward, reverse) = forward) {
 fields { amount: money = 100 SAR }
 lifecycle { states: [paid], initial: paid }
 action create {
  when direction is forward { moves self.amount from buyer to seller }
  when direction is reverse { moves self.amount from seller to buyer }
 }
}`
        : undefined,
  };
  const source = `program choices "Choices"
use choice
party buyer: person
party seller: business
sale = choice.transfer { direction: forward }`;
  const forward = compile(source, { standardLibrary });
  const reverse = compile(
    source.replace("direction: forward", "direction: reverse"),
    { standardLibrary },
  );
  const invalid = compile(
    source.replace("direction: forward", "direction: sideways"),
    { standardLibrary },
  );
  const from = (result: typeof forward) =>
    result.artifacts?.document.instruments[0]?.actions.create?.moves.map(
      (move) => ("from" in move ? move.from : undefined),
    );
  expect([from(forward), from(reverse), invalid.verdict]).toEqual([
    ["party.buyer"],
    ["party.seller"],
    "invalid",
  ]);
});

test("field branches follow the bound object shape in either declaration order", () => {
  const standardLibrary = {
    source: () => `header shape
instrument linked {
 fields { relation: text }
 lifecycle { states: [ready], initial: ready }
 action create {}
}
instrument plain {
 fields {}
 lifecycle { states: [ready], initial: ready }
 action create {}
}
instrument consumer(target: ref) {
 fields { amount: money = 1 SAR }
 lifecycle { states: [ready], initial: ready }
 action create {
  when target has relation { moves self.amount from buyer to seller }
 }
}`,
  };
  for (const kind of ["linked", "plain"])
    for (const reversed of [false, true]) {
      const declarations = [
        `item = shape.${kind} {}`,
        "consumer = shape.consumer { target: item }",
      ];
      if (reversed) declarations.reverse();
      const result = compile(
        `program shapes "Shapes"\nuse shape\nparty buyer: person\nparty seller: business\n${declarations.join("\n")}`,
        { standardLibrary },
      );
      if (!result.artifacts)
        throw new Error(JSON.stringify(result.diagnostics));
      expect(
        result.artifacts.document.instruments.find((i) => i.id === "consumer")!
          .actions.create!.moves.length,
      ).toBe(kind === "linked" ? 1 : 0);
    }
});

test("payout reserves before instruction-bound confirmation posts", () => {
  const result = compile(
    `program payout_test "Payout"
use money
party payer: person
party payee: business
payment = money.payout { payer: payer, payee: payee, amount: 1 SAR, max_age: 1d, adapter: "fixture" }
`,
    {
      adapterRegistry: {
        fixture: { adapter: genericAdapter, operation: "boundary.observe" },
      },
    },
  );
  const actions = result.artifacts?.document.instruments[0]?.actions;
  expect([
    actions?.instruct?.moves[0],
    actions?.instruct?.subject?.adapters[0]?.snapshot?.provider,
    actions?.confirm?.requires[0],
    actions?.confirm?.moves[0]?.operation,
    actions?.reject?.requires[0],
    actions?.reject?.moves[0]?.operation,
  ]).toEqual([
    {
      key: "move1",
      operation: "internal_transfer.reserve",
      amount: { field: "self.amount" },
      from: "party.payer",
      to: "party.payee",
      capture: "receipt",
      boundary: { adapter: "fixture" },
    },
    "conformance_boundary",
    {
      kind: "evidence",
      subject: "self.id",
      family: "boundary",
      check: "outcome",
      result: "confirmed",
      maxAge: 86400000,
      instruction: "self.receipt",
    },
    "internal_transfer.post",
    {
      kind: "evidence",
      subject: "self.id",
      family: "boundary",
      check: "outcome",
      result: "rejected",
      maxAge: 86400000,
      instruction: "self.receipt",
    },
    "internal_transfer.void",
  ]);
});

const boundaryEvidence = `program boundary_evidence "Boundary evidence"
instrument record {
 fields { receipt: text, amount: money }
 lifecycle { states: [open], initial: open }
 action create {
  requires evidence self.id family boundary check outcome result confirmed maxAge 1000 instruction self.receipt
 }
}`;

test("instruction evidence refuses nonterminal authorization", () => {
  const result = compile(
    boundaryEvidence.replace("result confirmed", "result acknowledged"),
  );
  expect(result.diagnostics.map((d) => d.message)).toContain(
    "$.instruments[0].actions.create.requires: instruction evidence requires a terminal outcome",
  );
});

test("instruction evidence requires a text identity path", () => {
  const result = compile(
    boundaryEvidence.replace(
      "instruction self.receipt",
      "instruction self.amount",
    ),
  );
  expect(result.verdict).toBe("invalid");
  expect(
    result.diagnostics.some((d) => d.message.includes("self.amount")),
  ).toBe(true);
});

test("boundary dispatch refuses an unknown adapter binding", () => {
  const result = compile(
    `program payout_test "Payout"
use money
party payer: person
party payee: business
payment = money.payout { payer: payer, payee: payee, amount: 1 SAR, max_age: 1d, adapter: "missing" }
`,
    {
      adapterRegistry: Object.create({
        missing: { adapter: genericAdapter, operation: "boundary.observe" },
      }),
    },
  );
  expect(result.diagnostics.map((d) => d.message)).toContain(
    "unknown boundary adapter missing",
  );
});

test("direct UDL refuses a boundary without its retained adapter snapshot", () => {
  const result = compile(
    `program payout_test "Payout"
use money
party payer: person
party payee: business
payment = money.payout { payer: payer, payee: payee, amount: 1 SAR, max_age: 1d, adapter: "fixture" }
`,
    {
      adapterRegistry: {
        fixture: { adapter: genericAdapter, operation: "boundary.observe" },
      },
    },
  );
  const document = result.artifacts!.document;
  delete document.instruments[0]!.actions.instruct!.subject;
  const validation = validateUdl(document);
  expect(
    validation.ok ? [] : validation.issues.map((issue) => issue.message),
  ).toContain("boundary reservation requires a retained adapter binding");
});

// Mutation: copy the sale purpose onto the fee and pass-through legs.
test("fee expansion preserves a separate economic purpose on each leg", () => {
  const result = compile(`program fee_purposes "Fees"
party buyer: person
instrument bill {
 fields { amount: money = 100 SAR }
 lifecycle { states: [paid], initial: paid }
 action create {
  moves self.amount from buyer to programOperator fee { seller: 1%, tax: 15% } economics {
   payee: { purpose: earning, sourceParty: buyer }
   fee: { purpose: earning, sourceParty: buyer }
   tax: { purpose: pass_through, sourceParty: buyer }
  }
 }
}`);
  expect(result.diagnostics).toEqual([]);
  expect(
    result.artifacts!.document.instruments[0]!.actions.create!.moves.map(
      (m) => m.economics?.purpose,
    ),
  ).toEqual(["earning", "earning", "pass_through"]);
});

// Mutation: treat a declared outside recipient as the company.
test("economics chooses a purpose from the resolved recipient", () => {
  for (const [recipient, purpose, sourceParty] of [
    ["operator", "earning", "owner"],
    ["provider", "participant_payout", "programOperator"],
  ] as const) {
    const result = compile(`program costs "Costs"
use financing
party provider: business
object purchase "Purchase" {
 fields { price: money }
 attach limits = financing.limits { borrower: owner, per_borrower: 1000 SAR }
 attach budget = financing.portfolio_limit { limit: 10000 SAR }
 attach plan = financing.installments { borrower: owner, capital: operator, months: 3, profit: 1%, disburse_to: borrower, limits: limits, portfolio: budget }
 attach charge = financing.late_charge { on: plan, borrower: owner, costs_to: ${recipient} }
}`);
    expect(result.diagnostics).toEqual([]);
    const receipt = result.artifacts!.document.instruments.find(
      (i) => i.id === "purchase_charge_cost_receipt",
    )!;
    expect(receipt.actions.create!.moves[0]!.economics).toEqual({
      purpose,
      sourceParty,
    });
    if (recipient === "operator")
      expect(receipt.actions.refund!.moves[0]!.economics).toMatchObject({
        purpose,
        reversalOf: "self.cashReceipt",
      });
    else expect(receipt.actions.refund!.moves[0]!.economics).toBeUndefined();
  }
});
