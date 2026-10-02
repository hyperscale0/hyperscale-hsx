import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import {
  financing,
  instrument,
  standardLibrary,
} from "./fixtures/std-source.ts";

// Mutation checkout-direct: remove the false requirement in the borrower branch.
test("direct borrower funding cannot expose escrow checkout", () => {
  const source = financing.replace(
    "funds: checkout",
    "disburse_to: borrower, funds: checkout",
  );
  expect(
    compile(source, { standardLibrary }).diagnostics.map((d) => d.message),
  ).toEqual(["action collect_down_payment is excluded by these bindings"]);
});

// Mutation pending-refund: remove the move from escrow.cancel.
test("abandoning pending checkout returns its actual credited balance", () => {
  const sale = instrument(financing, "purchase_sale");
  expect(sale.lifecycle.transitions.cancel).toEqual({
    from: ["pending"],
    to: "cancelled",
  });
  expect(sale.actions.cancel).toMatchObject({
    actor: { party: "actor" },
    publicAction: "cancel_checkout",
    allowZero: true,
    moves: [
      {
        from: "self.held",
        to: "party.actor",
        amount: { field: "self.held.balance" },
      },
    ],
  });
});

// Mutation escrow-reprice: fund from subject.price instead of self.price.
test("escrow funds the price captured by the agreement", () => {
  expect(
    instrument(financing, "purchase_sale").actions.fund!.moves,
  ).toMatchObject([
    { amount: { field: "self.price" }, from: "party.actor", to: "self.held" },
  ]);
});

// Mutation late-create-private: change late_charge.create to a parent actor.
test("an author exposes assessment creation before the clock assesses it", () => {
  const late = instrument(financing, "purchase_late");
  expect(late.actions.create!.publicAction).toBe("propose_assessment");
  expect(late.actions.create!.actor).toBe("caller");
  expect(late.actions.create!.requires).toContainEqual({
    kind: "compare",
    left: { field: "self.plan" },
    operator: "==",
    right: { field: "self.slice.plan" },
  });
  expect(late.actions.assess!.actor).toBe("clock");
  expect(late.lifecycle.transitions.assess).toEqual({
    from: ["proposed"],
    to: "assessed",
  });
});

// Mutation recognition-stale: restore the empty reschedule action.
test("rescheduling profit recognition copies the amended slice date", () => {
  const recognition = instrument(
    financing.replace(
      "profit_rate: 0%",
      "profit_rate: 0%, profit_earned: by_schedule",
    ),
    "purchase_plan_recognition",
  );
  expect(recognition.actions.reschedule!.calculate).toContainEqual({
    target: "dueAt",
    op: "shift",
    date: { field: "self.slice.dueAt" },
    milliseconds: { literal: 0 },
    direction: "after",
  });
});
