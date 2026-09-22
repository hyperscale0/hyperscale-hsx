import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { instrument } from "./fixtures/std-source.ts";

const source = readFileSync(
  new URL("../examples/travel.hsx", import.meta.url),
  "utf8",
)
  .replace("party hotel:", "party agency: business\nparty hotel:")
  .replace("supplier: hotel", "supplier: hotel, operator: agency")
  .replace(
    "expose activate as activate_cover",
    "expose activate as activate_cover, expose cancel as cancel_cover",
  );

// Mutation travel-payee: restore programOperator in the operator-net move.
test("travel earnings belong to the bound operator on completion and cancellation", () => {
  const booking = instrument(source, "holiday_reservation");
  for (const name of [
    "confirm",
    "cancel_middle",
    "cancel_late",
    "default_balance",
  ]) {
    const moves = booking.actions[name]!.moves;
    expect(moves[moves.length - 1]).toMatchObject({ to: "party.agency" });
  }
});

// Mutation coupled-cancellation: invoke cover.cancel from cancel_early.
test("booking cancellation excludes separately collected premium balances", () => {
  const booking = instrument(source, "holiday_reservation");
  expect(booking.actions.cancel_early!.moves).toMatchObject([
    {
      amount: { field: "self.held.balance" },
      from: "self.held",
      to: "party.actor",
    },
  ]);
  for (const name of [
    "cancel_early",
    "cancel_middle",
    "cancel_late",
    "default_balance",
    "timeout",
  ])
    expect(booking.actions[name]!.invoke ?? []).toEqual([]);
  const cover = instrument(source, "holiday_protection");
  expect(cover.actions.cancel!.publicAction).toBe("cancel_cover");
  expect(cover.actions.cancel!.invoke).toMatchObject([
    {
      selection: {
        instrument: "holiday_protection_slice",
        reference: "cover",
        anchor: "self.id",
        states: ["paid"],
        limit: 366,
      },
      action: "refund",
    },
  ]);
  const slice = instrument(source, "holiday_protection_slice");
  expect(slice.actions.refund!.publicAction).toBeUndefined();
  expect(slice.actions.refund!.deadline).toEqual({ at: "self.startsAt" });
});
