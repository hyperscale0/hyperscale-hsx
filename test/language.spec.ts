import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { compileCatalogue } from "../scripts/catalogue.ts";

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

test("the executable inventory closes every header's typed references", async () => {
  await compileCatalogue();
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
        `object = shape.${kind} {}`,
        "consumer = shape.consumer { target: object }",
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
