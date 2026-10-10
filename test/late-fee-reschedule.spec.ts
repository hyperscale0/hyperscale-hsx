import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { instrument } from "./fixtures/std-source.ts";

const rental = `program camera_rentals "Camera rentals"
use money
object rental "Camera rental" {
  fields { camera: text, returnBy: date }
  attach late = money.late_fee {
    payer: owner, payee: operator, amount: 50 SAR, cap: 300 SAR, period: 1d, grace: 1d
    rename { dueAt: returnBy }
    expose create as start_late_fees
    expose reschedule as change_return
    expose stop as record_return
  }
}`;

// Mutation: put create back on the payer. A customer who never agrees would
// stop the company from tracking the fee at all.
test("the company starts the late fee", () => {
  const create = instrument(rental, "rental_late").actions.create!;
  expect(create.publicAction).toBe("start_late_fees");
  expect(create.actor).toEqual({ party: "programOperator" });
});

// Mutation: drop the follows marker, or let follow move the date earlier. An
// action that moves returnBy would leave the fee on the old date, or a later
// move could pull charges forward.
test("follow keeps the fee on the renamed due field and only moves it later", () => {
  const fee = instrument(rental, "rental_late");
  const reschedule = fee.actions.reschedule!;
  expect(reschedule.publicAction).toBe("change_return");
  expect(reschedule.actor).toEqual({ party: "operator" });
  expect(reschedule.invoke).toEqual([
    { reference: "self.id", action: "follow", input: {} },
  ]);
  const follow = fee.actions.follow!;
  expect(follow.publicAction).toBeUndefined();
  expect(follow.actor).toBe("caller");
  expect(follow.follows).toBe("dueAt");
  expect(follow.subject?.requirements).toEqual([
    { field: { name: "dueAt", type: "date" }, objectField: "returnBy" },
  ]);
  expect(follow.requires).toContainEqual({
    kind: "compare",
    left: { field: "subject.dueAt" },
    operator: ">=",
    right: { field: "self.dueAt" },
  });
});

// Mutation: read self.dueAt in follow, or restart the count at the new date.
// The fee would keep the create-time date, or charge posted days again.
test("follow reads the renamed due field live and keeps the periods already charged", () => {
  const fee = instrument(rental, "rental_late");
  const follow = fee.actions.follow!;
  expect(follow.calculate?.[0]).toMatchObject({
    target: "graceEndsAt",
    date: { field: "subject.dueAt" },
  });
  expect(follow.calculate?.at(-1)).toEqual({
    target: "followingAt",
    op: "step",
    date: { field: "self.firstAt" },
    period: { literal: "PT1S" },
    times: { field: "self.elapsed" },
  });
  expect(follow.set).toEqual({
    dueAt: { field: "subject.dueAt" },
    nextAt: { field: "self.followingAt" },
  });
  // The clock skips an instant it already ran at, so the next charge must
  // land after the last posted one.
  expect(follow.requires).toContainEqual({
    kind: "compare",
    left: { field: "self.followingAt" },
    operator: ">",
    right: { field: "self.lastAt" },
  });
  expect(fee.actions.charge!.set).toMatchObject({
    lastAt: { field: "self.nextAt" },
  });
  expect(fee.actions.charge!.calculate).toContainEqual({
    target: "elapsed",
    op: "sum",
    values: [{ field: "self.elapsed" }, { field: "self.stride" }],
  });
});

const custom = (follow: string) => `program shop "Shop"
object rental "Rental" {
  fields { returnBy: date }
  attach tab = tab { }
}
instrument tab() {
  fields { dueAt: date }
  lifecycle { states: [open], initial: open }
  action create { actor: { party: programOperator }, subject { dueAt: date }, set: { dueAt: { field: subject.dueAt } } }
  ${follow}
}`;

// Mutation: drop either check in UDL validation. The engine would run an
// action for whoever changed the field, or skip a refusal that already moved
// money.
test("a follow action binds its field and runs for the caller with no effects", () => {
  const messages = (follow: string) =>
    compile(custom(follow)).diagnostics.map((item) => item.message);
  expect(
    messages(
      "action follow { from: open, to: open, follows: dueAt, subject { dueAt: date } }",
    ),
  ).toEqual([]);
  expect(
    messages("action follow { from: open, to: open, follows: dueAt }"),
  ).toContainEqual(
    expect.stringContaining("follows names no subject requirement dueAt"),
  );
  expect(
    messages(
      "action follow { from: open, to: open, follows: dueAt, actor: { party: programOperator }, subject { dueAt: date } }",
    ),
  ).toContainEqual(
    expect.stringContaining("a follow action is a caller transition"),
  );
});
