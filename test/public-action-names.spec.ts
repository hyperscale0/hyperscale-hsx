import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

const source = `program p "P"
instrument record {
 lifecycle { states: [open], initial: open }
 action create {}
 action check { from: open, to: open }
}
`;

// Mutation: give a program instrument's caller actions an automatic public name.
test("a program instrument publishes only the action an expose line names", () => {
  const three = source.replace(
    " action check { from: open, to: open }",
    " action check { from: open, to: open }\n action close { from: open, to: open }",
  );
  const actions = compile(three + "expose record.check as check_record")
    .artifacts?.document.instruments[0]?.actions;
  expect(
    Object.entries(actions ?? {}).flatMap(([name, action]) =>
      action.publicAction ? [[name, action.publicAction]] : [],
    ),
  ).toEqual([["check", "check_record"]]);
});

// Mutation: let a second expose silently replace the first's public name.
test("two actions cannot share one public name", () => {
  const exposure =
    "expose record.create as open_record\nexpose record.check as open_record";
  const result = compile(source + exposure);
  expect(result.artifacts).toBeUndefined();
  const diagnostic = result.diagnostics[0]!;
  expect(diagnostic.message).toBe(
    "public action open_record is given twice on record, at 7:1 and 8:1",
  );
  expect(diagnostic.related?.[0]?.span.start).toBe(
    (source + exposure).indexOf("expose record.create"),
  );
});

const rental = (deposit: string, fee: string) => `program lensday "Lensday"
object rental "Rentals" {
  fields { camera: text }
  attach booking = booking.reservation { customer: owner, expose create, expose pay_deposit, expose pay_balance }
  attach deposit = money.hold { payer: owner, payee: operator, ${deposit}, expose fund as pay_security }
  attach late_fee = money.transfer { payer: owner, payee: operator, ${fee}, expose pay as pay_late_fee }
}
`;

// Mutation: drop the per-object namespace check so UDL2001 reports at 1:1.
test("a public action exposed by two attachments points at the second expose", () => {
  const source = rental("expose create", "expose create as charge_late_fee");
  const result = compile(source);
  expect(result.diagnostics).toHaveLength(1);
  const diagnostic = result.diagnostics[0]!;
  const column = source.split("\n")[4]!.indexOf("expose create") + 1;
  expect(diagnostic).toMatchObject({
    code: "HSX1001",
    line: 5,
    column,
    endLine: 5,
    endColumn: column + "expose create".length,
    message:
      "`deposit` exposes `create`, which `booking` already exposes on `rental`",
    fix: "Give it its own public name, for example `expose create as deposit_create`.",
  });
  expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toBe(
    "expose create",
  );
  expect(
    compile(rental("expose create as open_deposit", "expose create as fee"))
      .diagnostics,
  ).toEqual([]);
});

// Mutation: report every collision at one shared span, so lines repeat.
test("each colliding expose reports once at its own line", () => {
  const result = compile(rental("expose create", "expose create"));
  expect(
    result.diagnostics.map((d) => [d.line, d.message.split(",")[0]]),
  ).toEqual([
    [5, "`deposit` exposes `create`"],
    [6, "`late_fee` exposes `create`"],
  ]);
});

// Mutation: map object issues to program.span or drop the issue dedupe.
test("an object-level UDL issue points at its row, once", () => {
  const source = `program p "P"
object rental "Rentals" {
  fields { camera: text }
  columns: [camera, camera, camera]
  attach fee = money.transfer { payer: owner, payee: operator, expose create as charge, expose pay as pay_fee }
}
`;
  const result = compile(source);
  expect(
    result.diagnostics.map((d) => [d.code, d.message, d.line, d.column]),
  ).toEqual([["UDL2001", "$.objects[0].columns: duplicate camera", 4, 3]]);
});
