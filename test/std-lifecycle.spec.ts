import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { instrument, financing } from "./fixtures/std-source.ts";

const example = (name: string) =>
  readFileSync(new URL(`../examples/${name}.hsx`, import.meta.url), "utf8");

// Mutation unverified-return: change escrow.refund from return_verified to disputed.
// Mutation stuck-funded: drop funded from escrow.refund, so an undelivered hold has no exit.
// Mutation lender-cash-refund: drop the live-plan guard from escrow.refund, or
// leave written_off out of either refund's guard.
test("a seller refunds before delivery, or after verifying a return", () => {
  const sale = instrument(financing, "purchase_sale");
  expect(sale.actions.verify_return).toMatchObject({
    publicAction: "verify_return",
    actor: { party: "owner" },
  });
  expect(sale.lifecycle.transitions.verify_return).toEqual({
    from: ["disputed"],
    to: "return_verified",
  });
  expect(sale.lifecycle.transitions.refund).toEqual({
    from: ["funded", "return_verified"],
    to: "refunded",
  });
  expect(sale.actions.refund).toMatchObject({
    publicAction: "refund_order",
    actor: { party: "owner" },
    moves: [
      {
        amount: { field: "self.held.balance" },
        from: "self.held",
        to: "party.actor",
      },
    ],
  });
  // Only a cancelled plan has returned its principal to capital, so a new
  // installments state blocks both refunds until someone decides otherwise.
  const funding = instrument(financing, "purchase_plan").lifecycle.states;
  for (const name of ["refund", "refund_undelivered"])
    expect(sale.actions[name]!.requires).toContainEqual(
      expect.objectContaining({
        kind: "aggregate",
        selection: expect.objectContaining({
          instrument: ["purchase_plan"],
          reference: "funds",
          states: funding.filter((state) => state !== "cancelled"),
        }),
        value: { literal: 0 },
      }),
    );
});

// Mutation empty-parent: keep an action whose parent actor is an empty all().
// An escrow-only program then fails to compile, since a parent list needs a member.
test("only a financed hold has the plan-run unwind", () => {
  const sale = instrument(financing, "purchase_sale");
  expect(sale.actions.unwind_financed!.actor).toEqual({
    parent: ["purchase_plan"],
  });
  expect(sale.lifecycle.transitions.unwind_financed).toEqual({
    from: ["funded", "return_verified"],
    to: "refunded",
  });
  const plain = instrument(
    `program shop "Shop"
use escrow
object order "Order" {
 attach sale = escrow.hold { payer: actor, payee: owner }
}`,
    "order_sale",
  );
  expect(sale.actions.confirm!.actor).toEqual({ parent: ["purchase_plan"] });
  expect(plain.actions.confirm).toBeUndefined();
  expect(plain.actions.unwind_financed).toBeUndefined();
  expect(plain.lifecycle.transitions.unwind_financed).toBeUndefined();
  expect(plain.actionOrder).not.toContain("unwind_financed");
});

// Mutation post-approval-denial: add approved to insurance.claim.deny from-states.
test("claim approval and denial are alternatives from submitted", () => {
  const claim = instrument(example("insurance"), "device_claim");
  expect(claim.lifecycle.transitions.deny).toEqual({
    from: ["submitted"],
    to: "denied",
  });
  expect(claim.lifecycle.transitions.approve).toEqual({
    from: ["submitted"],
    to: "approved",
  });
  expect(claim.lifecycle.transitions.pay).toEqual({
    from: ["approved"],
    to: "paid",
  });
});

// Mutation payout-is-contribution: restore paid as the membership payout state.
test("membership payout counts received pots independently of paid contributions", () => {
  const source = example("savings");
  const member = instrument(source, "group_membership");
  expect(member.lifecycle.transitions.receive).toEqual({
    from: ["active"],
    to: "received",
  });
  expect(member.actions.receive!.requires).toEqual([
    { kind: "state", reference: "self.circle", states: ["active"] },
    {
      kind: "aggregate",
      selection: {
        instrument: ["group_membership"],
        reference: "circle",
        anchor: "self.circle",
        states: ["received"],
        limit: 60,
      },
      measure: "count",
      operator: "==",
      value: { field: "self.preceding" },
    },
  ]);
  expect(member.actions.receive!.moves).toMatchObject([
    {
      amount: { field: "self.total" },
      from: "self.circle.held",
      to: "self.member",
    },
  ]);
  const circle = instrument(source, "group_circle");
  expect(circle.actions.close!.requires).toContainEqual({
    kind: "aggregate",
    selection: {
      instrument: "group_membership",
      reference: "circle",
      anchor: "self.id",
      states: ["received"],
      limit: 60,
    },
    measure: "count",
    operator: "==",
    value: { field: "self.members" },
  });
});

// Mutation late-contribution-ban: add a deadline to contribution.pay.
test("a late contribution remains admitted after its member receives the pot", () => {
  const contribution = instrument(
    example("savings"),
    "group_membership_contribution",
  );
  expect(contribution.lifecycle.transitions.pay).toEqual({
    from: ["pending"],
    to: "paid",
  });
  expect(contribution.actions.pay).toMatchObject({
    actor: "clock",
    due: { at: "self.dueAt" },
    requires: [
      {
        kind: "state",
        reference: "self.membership",
        states: ["active", "received"],
      },
      {
        kind: "state",
        reference: "self.membership.circle",
        states: ["active"],
      },
    ],
  });
  expect(contribution.actions.pay!.deadline).toBeUndefined();
});

// Mutation refund-expiry-wait: add due self.authorization.expiresAt to refund.
test("a captured card transaction can refund before authorization expiry", () => {
  const transaction = instrument(example("cards"), "employee_receipt");
  expect(transaction.actions.create!.requires).toContainEqual({
    kind: "state",
    reference: "self.authorization",
    states: ["captured"],
  });
  expect(transaction.lifecycle.transitions.refund).toEqual({
    from: ["posted"],
    to: "refunded",
  });
  expect(transaction.actions.refund!.due).toBeUndefined();
  expect(transaction.actions.refund!.deadline).toBeUndefined();
  expect(transaction.actions.refund!.moves).toMatchObject([
    {
      amount: { field: "self.amount" },
      from: "self.authorization.merchant",
      to: "self.authorization.card.holder.holder",
    },
  ]);
});
