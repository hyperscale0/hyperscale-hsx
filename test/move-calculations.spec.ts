import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

const tab = (fields: string, actions: string, states = "open, paid") => {
  const result = compile(`program shop "Shop"
party merchant: business
party agent: business
instrument tab(payer: party) {
  fields { price: money = 100 SAR, discount: money = 10 SAR, ${fields} }
  lifecycle { states: [${states}], initial: open }
  action create {}
  ${actions}
}
object sale "Sale" {
  attach tab = tab { payer: owner
  expose create as open_tab
  expose pay as pay }
}`);
  expect(result.diagnostics).toEqual([]);
  return result.artifacts!.document.instruments[0]!;
};
const due =
  "calculate: [{ target: due, op: subtract, base: { field: self.price }, subtract: [{ field: self.discount }] }]";
const pay = (move: string, calculate = due) => `action pay {
    from: open, to: paid, actor: { party: payer }
    input { tip: money }
    ${calculate}
    moves ${move}
  }`;
const targets = (calculations: readonly { target: string }[] = []) =>
  calculations.map(({ target }) => target);

// Mutation: lower the fee by the input. prefix alone. Create then reads an
// unset due and refuses, and later actions charge on the previous due.
test("a fee on an amount its action calculates runs with that action", () => {
  const instrument = tab(
    "due: money?",
    pay("self.due from payer to merchant fee { seller: 10%, tax: 15% }"),
  );
  expect(targets(instrument.calculate)).toEqual([]);
  expect(targets(instrument.actions.pay!.calculate)).toEqual([
    "due",
    "pay_move1_feeGross",
    "pay_move1_tax",
    "pay_move1_debit",
    "pay_move1_net",
  ]);
  expect(
    instrument.fields.find(({ name }) => name === "pay_move1_net"),
  ).toMatchObject({ optional: true });
});

// Mutation: read only the paying action's calculate when deciding.
test("a fee on an amount another action calculates runs with its move", () => {
  const instrument = tab(
    "due: money",
    `action bill { from: open, to: billed, ${due} }
  action pay { from: billed, to: paid, actor: { party: payer }, moves self.due from payer to merchant fee { seller: 10% } }`,
    "open, billed, paid",
  );
  expect(targets(instrument.calculate)).toEqual([]);
  expect(targets(instrument.actions.pay!.calculate)).toEqual([
    "pay_move1_feeGross",
    "pay_move1_debit",
    "pay_move1_net",
  ]);
});

// Mutation: always push split shares into the instrument's calculate.
test("a split on a calculated amount or an action input runs with its action", () => {
  for (const amount of ["self.due", "input.tip"]) {
    const instrument = tab(
      "due: money?",
      pay(`${amount} from payer shares { merchant: 70%, agent: 30% }`),
    );
    expect(targets(instrument.calculate)).toEqual([]);
    expect(instrument.actions.pay!.calculate).toEqual([
      expect.objectContaining({ target: "due" }),
      {
        target: "pay_move1_share1",
        op: "rate",
        base: { field: amount },
        bps: { literal: 7000 },
        rounding: "floor",
      },
      {
        target: "pay_move1_share2",
        op: "subtract",
        base: { field: amount },
        subtract: [{ field: "self.pay_move1_share1" }],
      },
    ]);
  }
});

// Mutation: lower every fee per action. Agreements then lose their fee terms
// at create and a set field is charged before its assignment.
test("a fee on an amount held from create stays an instrument calculation", () => {
  const instrument = tab(
    "due: money?",
    pay("self.price from payer to merchant fee { seller: 10% }", ""),
  );
  expect(targets(instrument.calculate)).toEqual([
    "pay_move1_feeGross",
    "pay_move1_debit",
    "pay_move1_net",
  ]);
  expect(instrument.actions.pay!.calculate).toBeUndefined();
});

const diagnostics = (source: string) =>
  compile(source).diagnostics.map(({ message, line }) => [message, line]);
const attach = (header: string, tunables: string) => `program shop "Shop"
use ${header.split(".")[0]}
party merchant: business
object sale "Sale" {
  fields { price: money }
  attach payment = ${header} {
    ${tunables}
    expose create as open_sale
  }
}`;

// Mutation: drop the sign check. The whole part then fails the digit test
// and the author reads a decimal-places message.
test("a negative amount says it cannot be negative", () => {
  expect(
    diagnostics(
      attach(
        "money.transfer",
        "payer: owner, payee: operator, amount: -150 SAR",
      ),
    ),
  ).toEqual([["amount: literal cannot be negative", 7]]);
});

// Mutation: drop the runtime case from literal. The author reads "expected a literal".
test("runtime on a compile-time tunable says the value is fixed", () => {
  expect(
    diagnostics(
      attach(
        "money.schedule",
        "payer: owner, payee: operator, amount: 100 SAR, count: runtime",
      ),
    ),
  ).toEqual([
    [
      "this value is fixed when the program compiles, so it cannot be runtime",
      7,
    ],
  ]);
  expect(
    diagnostics(
      attach(
        "money.schedule",
        "payer: owner, payee: operator, amount: 100 SAR, count: 0",
      ),
    ),
  ).toEqual([["count: value is outside 1..366", 7]]);
});

// Mutation: drop the held-account check. The prover then blames settle_release.
test("a buyer fee on a held account names the fee", () => {
  expect(
    diagnostics(
      attach(
        "escrow.hold",
        "payer: owner, payee: merchant, fee: { buyer: 2%, tax: 15% }",
      ),
    ),
  ).toEqual([
    [
      "a buyer fee cannot come from `held`, which holds only the moved amount",
      7,
    ],
  ]);
});
