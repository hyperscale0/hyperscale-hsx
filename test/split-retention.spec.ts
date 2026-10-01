import { expect, test } from "bun:test";
import { projectDocumentSemantics } from "@hyperscale0/udl";
import { compile } from "../src/compile.ts";

function split(shares: string, amount = "300 SAR") {
  return compile(`program commission "Commission"
use money
party partner: business
party other: business
object payment "Payment" {
 attach settlement = money.split {
  payer: programOperator, amount: ${amount}, shares: { ${shares} }
 }
}`);
}

// Mutation: restore the equivalent-account split leg with the saved compiler patch.
test("a split retains its source allocation in calculated facts without a transfer fee", () => {
  const result = split("partner: 85%, programOperator: 15%");
  expect(result.diagnostics).toEqual([]);
  const { document, costManifest } = result.artifacts!;
  const instrument = document.instruments[0]!;
  expect(instrument.actions.pay!.moves).toEqual([
    {
      key: "move1_1",
      operation: "internal_transfer.create",
      amount: { field: "self.pay_move1_share1" },
      from: "party.programOperator",
      to: "party.partner",
    },
  ]);
  expect(costManifest.actions[`${instrument.id}.pay`]!.transfers).toBe(1);
  const facts = projectDocumentSemantics(document).instruments[0]!;
  expect(facts.calculations).toEqual([
    {
      target: "pay_move1_share1",
      op: "rate",
      base: { field: "self.amount" },
      bps: { literal: 8500 },
      rounding: "floor",
    },
    {
      target: "pay_move1_share2",
      op: "subtract",
      base: { field: "self.amount" },
      subtract: [{ field: "self.pay_move1_share1" }],
    },
  ]);
  expect(facts.fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "pay_move1_share2", type: "money" }),
    ]),
  );
  const retained = split("programOperator: 100%");
  expect(retained.diagnostics).toEqual([]);
  expect(
    retained.artifacts!.document.instruments[0]!.actions.pay!.moves,
  ).toEqual([]);
  expect(
    retained.artifacts!.costManifest.actions[`${instrument.id}.pay`]!.transfers,
  ).toBe(0);
});

// Mutation: compare party names alone. The named-account control must still post.
test("account aliases retain only the same book and key, while another account of the party posts", () => {
  const source = `program aliases "Aliases"
use custom
object payment "Payment" { attach settlement = custom.allocation {} }`;
  const header = (key: string) => `header custom
instrument allocation {
 fields { source: account(programOperator, cash, "${key}"), amount: money = 300 SAR }
 lifecycle { states: [pending, paid], initial: pending }
 action create {}
 action pay { from: pending, to: paid, moves self.amount from self.source shares { programOperator: 100% } }
}`;
  for (const [key, transfers] of [
    ["balance", 0],
    ["commission", 1],
  ] as const) {
    const result = compile(source, {
      standardLibrary: { source: () => header(key) },
    });
    expect(result.diagnostics).toEqual([]);
    expect(
      result.artifacts!.document.instruments[0]!.actions.pay!.moves,
    ).toHaveLength(transfers);
  }
});

// Mutation: remove a recipient before calculating shares, or renumber surviving moves.
test("retention preserves final-recipient rounding and the original remaining leg keys", () => {
  for (const shares of [
    "programOperator: 33.33%, partner: 33.33%, other: 33.34%",
    "partner: 33.33%, programOperator: 33.33%, other: 33.34%",
    "partner: 33.33%, other: 33.33%, programOperator: 33.34%",
  ]) {
    const result = split(shares, "100.01 SAR");
    expect(result.diagnostics).toEqual([]);
    const instrument = result.artifacts!.document.instruments[0]!;
    const control = split(
      shares.replace("programOperator", "owner"),
      "100.01 SAR",
    );
    expect(control.diagnostics).toEqual([]);
    const original = control.artifacts!.document.instruments[0]!;
    expect(instrument.calculate).toEqual(original.calculate);
    expect(instrument.actions.pay!.moves).toEqual(
      original.actions.pay!.moves.filter(
        (move) => !("to" in move) || move.to !== "party.owner",
      ),
    );
    expect(instrument.calculate.at(-1)).toEqual({
      target: "pay_move1_share3",
      op: "subtract",
      base: { field: "self.amount" },
      subtract: [
        { field: "self.pay_move1_share1" },
        { field: "self.pay_move1_share2" },
      ],
    });
  }
});

// Mutations: validate only posted percentages, or suppress explicit self-transfers too.
test("the full split must total 100 percent and explicit self-transfers still refuse", () => {
  expect(split("partner: 85%, programOperator: 14%").diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: "split percentages must sum to 100%",
      }),
    ]),
  );
  const result = compile(`program self_transfer "Self transfer"
use money
object payment "Payment" {
 attach payment = money.transfer { payer: programOperator, payee: programOperator, amount: 300 SAR }
}`);
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "UDL4001",
        message: expect.stringContaining("a transfer needs distinct accounts"),
      }),
    ]),
  );
});
