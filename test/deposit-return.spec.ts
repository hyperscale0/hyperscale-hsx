import { expect, test } from "bun:test";
import { instrument } from "./fixtures/std-source.ts";

const rental = (binding: string) => `program camera_rentals "Camera rentals"
use money
object rental "Camera rental" {
  fields { camera: text, returnBy: date }
  attach deposit = money.hold {
    payer: owner, payee: operator, amount: 1000 SAR${binding}
    expose create as agree_deposit
    expose fund as pay_deposit
    expose refund as record_return
  }
  attach late = money.late_fee {
    payer: owner, payee: operator, amount: 50 SAR, cap: 300 SAR, period: 1d, grace: 1d
    rename { dueAt: returnBy }
    expose create as agree_late_fees
    expose stop as stop_late_fees
  }
}`;

// Mutation: invoke stop by reference, or select late fees by payer alone. A
// refund would then refuse once the fee is capped, or stop the same
// customer's late fee on another rental.
test("a hold bound to a late fee stops that fee, only while it runs, when it refunds", () => {
  const hold = instrument(rental(", late_fee: late"), "rental_deposit");
  expect(hold.fields).toContainEqual({
    name: "lateFee",
    type: "ref",
    targetKind: "instrument",
    target: "rental_late",
  });
  // Refund runs as the hold's payee and stop admits the fee's payee, so both
  // agreements must name the same parties or the link would never act.
  expect(hold.actions.create!.requires).toEqual([
    {
      kind: "compare",
      left: { field: "self.lateFee.payer" },
      operator: "==",
      right: { field: "self.payer" },
    },
    {
      kind: "compare",
      left: { field: "self.lateFee.payee" },
      operator: "==",
      right: { field: "self.payee" },
    },
  ]);
  expect(hold.actions.refund!.publicAction).toBe("record_return");
  expect(hold.actions.refund!.invoke).toEqual([
    {
      selection: {
        instrument: "rental_late",
        reference: "payer",
        anchor: "self.payer",
        states: ["running"],
        limit: 1,
        where: { id: { field: "self.lateFee" } },
      },
      action: "stop",
      input: {},
    },
  ]);
});

// Mutation: emit the link without the binding. Every existing deposit would
// need a late fee on its object before it could be created.
test("a hold without a late fee compiles as before", () => {
  const hold = instrument(rental(""), "rental_deposit");
  expect(hold.fields.map((field) => field.name)).not.toContain("lateFee");
  expect(hold.actions.create!.requires).toEqual([]);
  expect(hold.actions.create!.input).toEqual([]);
  expect(hold.actions.refund!.invoke).toBeUndefined();
});
