import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";
import { document, standardLibrary } from "./fixtures/std-source.ts";

test("wallet balances remain recoverable after later credits", () => {
  const wallet = document(`program p "P"
use wallet
object account "Account" {
  attach balance = wallet.balance { holder: owner }
}`).instruments[0]!;
  expect(wallet.lifecycle.states).toEqual(["pending", "active", "frozen"]);
  expect(wallet.actions.close).toBeUndefined();
  expect(wallet.actions.operator_close).toBeUndefined();
});

test("marketplace caps include sibling attachments on the same listing", () => {
  const source = `program market "Market"
use marketplace
use escrow
object item "Item" {
  attach listing = marketplace.listing { seller: owner }
  attach sale = escrow.hold { payer: actor, payee: owner }
  attach second_order = marketplace.order { listing: listing, buyer: actor }
  attach order = marketplace.order { listing: listing, buyer: actor }
  attach second_reservation = marketplace.reservation { listing: listing, funds: sale, converters: order, buyer: actor, seller: owner }
  attach reservation = marketplace.reservation { listing: listing, funds: sale, converters: order, buyer: actor, seller: owner }
}`;
  const instruments = document(source).instruments;
  for (const [name, states] of [
    ["order", ["placed", "fulfilled"]],
    ["reservation", ["active"]],
  ] as const) {
    for (const id of [`item_${name}`, `item_second_${name}`]) {
      const item = instruments.find((i) => i.id === id)!;
      expect(item.invariants).toContainEqual({
        kind: "aggregate",
        selection: {
          instrument: [`item_second_${name}`, `item_${name}`],
          reference: "listing",
          anchor: "self.listing",
          states: [...states],
          limit: 366,
        },
        measure: "count",
        operator: "<=",
        value: { literal: 1 },
      });
      if (name === "order")
        expect(
          item.actions.commit!.requires?.some((r) => r.kind === "aggregate"),
        ).toBe(false);
    }
  }
});

test("seller fees plus tax fit within the base amount", () => {
  const escrow = readFileSync(
    new URL("../examples/escrow.hsx", import.meta.url),
    "utf8",
  );
  for (const [fee, valid] of [
    ["seller: 100%, tax: 15%", false],
    ["seller: 100% cap 1 SAR, tax: 15%", true],
    ["seller: 100% cap 100000 SAR, tax: 15%", true],
    ["seller: 50%, tax: 100%", true],
    ["seller: 50.01%, tax: 100%", false],
    ["seller: 100%, tax: 0%", true],
    ["seller: 5%, tax: 15%", true],
  ] as const) {
    const result = compile(escrow.replace("seller: 5%, tax: 15%", fee), {
      standardLibrary,
    });
    if (valid) expect(result.diagnostics).toEqual([]);
    else
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "seller_fee_exceeds_amount" }),
      );
  }
});

test("literal seller fees use the capped charge and floored tax", () => {
  for (const [amount, fee, valid] of [
    ["100 SAR", "seller: 100% cap 1 SAR, tax: 15%", true],
    ["100 SAR", "seller: 100% cap 100 SAR, tax: 15%", false],
    ["100 SAR", "seller: 50% cap 200 SAR, tax: 15%", true],
    ["100 SAR", "seller: 100% cap 86.96 SAR, tax: 15%", true],
    ["100 SAR", "seller: 100% cap 87 SAR, tax: 15%", false],
    ["0.01 SAR", "seller: 100%, tax: 15%", true],
    ["100 SAR", "seller: 100%, tax: 15%", false],
  ] as const) {
    const result = compile(`program shop "Shop"
party seller: business
instrument payment(payer: party) {
  fields {}
  lifecycle { states: [open, paid], initial: open }
  action create {}
  action pay { from: open, to: paid, actor: { party: payer }
    moves ${amount} from payer to seller fee { ${fee} }
  }
}
object sale "Sale" {
  attach payment = payment { payer: owner
    expose create as open_payment
    expose pay as pay
  }
}`);
    if (valid) expect(result.diagnostics).toEqual([]);
    else
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "seller_fee_exceeds_amount" }),
      );
  }
});
