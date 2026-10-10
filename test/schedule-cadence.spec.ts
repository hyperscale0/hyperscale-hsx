import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { templateGuide } from "../src/template-guide.ts";
import { standardLibrary } from "./fixtures/std-source.ts";

const program = (bindings: string, extra = "") => `program gym "Gym"
use money
object membership "Membership" {
 attach dues = money.schedule { ${bindings}
  expose create as start, expose activate as accept, expose stop as end }
${extra}
}`;

const instruments = (bindings: string) => {
  const result = compile(program(bindings), { standardLibrary });
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  const find = (id: string) =>
    result.artifacts!.document.instruments.find((item) => item.id === id)!;
  return {
    schedule: find("membership_dues"),
    occurrence: find("membership_dues_occurrence"),
  };
};

// Round 8 F4: a monthly plan took twelve hand-typed dates.
test("every makes one piece at a time from a start date, stepping calendar months", () => {
  const { schedule, occurrence } = instruments(
    "payer: owner, payee: operator, amount: 150 SAR, every: 1 month",
  );
  expect(schedule.actions.create!.input.map((field) => field.name)).toEqual([
    "startsAt",
  ]);
  // create makes the first piece only; nothing waits beyond the next one.
  expect(schedule.actions.create!.invoke).toEqual([
    {
      instrument: "membership_dues_occurrence",
      action: "create",
      input: { schedule: { field: "self.id" }, position: { literal: 1 } },
    },
  ]);
  expect(occurrence.calculate).toContainEqual({
    target: "dueAt",
    op: "step",
    date: { field: "self.schedule.startsAt" },
    period: { literal: "P1M" },
    times: { field: "self.offset" },
  });
  // Without count, paying a piece always makes the next one.
  expect(occurrence.actions.pay!.invoke).toEqual([
    {
      instrument: "membership_dues_occurrence",
      action: "create",
      input: {
        schedule: { field: "self.schedule" },
        position: { field: "self.following" },
      },
    },
  ]);
  expect(occurrence.actions.create!.actor).toEqual({
    parent: ["membership_dues", "membership_dues_occurrence"],
  });
});

test("an authored count stops the chain after count pieces", () => {
  const { occurrence } = instruments(
    "payer: owner, payee: operator, amount: 150 SAR, every: 2 weeks, count: 6",
  );
  expect(occurrence.actions.pay!.invoke![0]).toMatchObject({
    guard: {
      kind: "compare",
      left: { field: "self.position" },
      operator: "<",
      right: { literal: 6 },
    },
  });
  expect(occurrence.calculate).toContainEqual(
    expect.objectContaining({ op: "step", period: { literal: "P2W" } }),
  );
});

test("without every the schedule keeps its dated form and needs a count", () => {
  const { schedule, occurrence } = instruments(
    "payer: owner, payee: operator, amount: 750 SAR, count: 4",
  );
  expect(schedule.actions.create!.input).toEqual([
    { name: "dates", type: "list", item: "date", maxItems: 4 },
  ]);
  expect(schedule.actions.create!.invoke![0]).toMatchObject({
    range: { count: { literal: 4 }, maximum: 4, bind: "position" },
  });
  expect(occurrence.actions.pay!.invoke ?? []).toEqual([]);
  expect(occurrence.fields.map((field) => field.name)).toContain("base");
  const result = compile(
    program("payer: owner, payee: operator, amount: 750 SAR"),
    { standardLibrary },
  );
  expect(result.verdict).toBe("invalid");
  expect(result.diagnostics[0]).toMatchObject({
    code: "HSX1001",
    message:
      "Attachment `dues` charges on a list of dates, so it needs `count`, the number of dates.",
    fix: "Add `count: 3` for three dated pieces, or add `every: 1 month` to charge each month until stopped or cancelled.",
  });
});

// Channel trials: the catalog showed `count = 12`, so agents wrote count: 366
// for a membership that runs until the member cancels.
test("count reads as optional, and only a counted plan keeps its total", () => {
  const signature = templateGuide("money.schedule")!.signature;
  expect(signature).toContain("count: integer(1, 366)?");
  expect(signature).not.toContain("= 12");
  const count = templateGuide("money.schedule")!.tunables.find(
    (tunable) => tunable.name === "count",
  )!;
  expect(count).toMatchObject({ required: false, type: "integer(1, 366)?" });
  expect(count).not.toHaveProperty("default");
  const fields = (bindings: string) =>
    Object.fromEntries(
      instruments(bindings).schedule.fields.map((field) => [
        field.name,
        "value" in field ? field.value : undefined,
      ]),
    );
  const open = fields(
    "payer: owner, payee: operator, amount: 150 SAR, every: 1 month",
  );
  expect(open).not.toHaveProperty("count");
  expect(Object.keys(open)).toEqual(["amount", "startsAt"]);
  expect(
    fields(
      "payer: owner, payee: operator, amount: 150 SAR, every: 1 month, count: 12",
    ),
  ).toMatchObject({ count: 12 });
});

test("every takes days, weeks, months and years, and refuses a clock time", () => {
  for (const [written, iso] of [
    ["1 year", "P1Y"],
    ["3 months", "P3M"],
    ["7d", "P7D"],
    ["P2W", "P2W"],
  ]) {
    const { occurrence } = instruments(
      `payer: owner, payee: operator, amount: 10 SAR, every: ${written}`,
    );
    expect(occurrence.calculate).toContainEqual(
      expect.objectContaining({ op: "step", period: { literal: iso } }),
    );
  }
  const result = compile(
    program("payer: owner, payee: operator, amount: 10 SAR, every: 5 minutes"),
    { standardLibrary },
  );
  expect(result.verdict).toBe("invalid");
  expect(result.diagnostics[0]!.message).toBe("every needs a calendar period");
});

// Round 8 F2: run B bound payer: actor while the payee runs create, so the
// company paid itself every month.
test("check refuses a schedule whose payer is the payee that runs create", () => {
  for (const [bindings, both] of [
    ["payer: actor, payee: owner", "owner"],
    ["payer: actor, payee: operator", "operator"],
  ]) {
    const result = compile(
      program(`${bindings}, amount: 750 SAR, every: 1 month`),
      { standardLibrary },
    );
    expect(result.verdict).toBe("invalid");
    const [diagnostic] = result.diagnostics;
    expect(diagnostic!.code).toBe("same_party_move");
    expect(diagnostic!.message).toBe(
      `dues: occurrence.pay moves money from payer: actor to payee: ${both}, and both are ${both}. payee runs create, so actor is ${both}. A party cannot pay itself.`,
    );
  }
});

test("check warns when only the run decides whether the company pays itself", () => {
  const result = compile(
    program(
      "payer: owner, payee: operator, amount: 750 SAR, every: 1 month",
      " attach fee = money.transfer { payer: actor, payee: operator, amount: 50 SAR\n  expose create as start_fee, expose pay as pay_fee }",
    ),
    { standardLibrary },
  );
  expect(result.verdict).toBe("valid");
  const warnings = result.warnings.filter(
    (warning) => warning.code === "same_party_move",
  );
  expect(warnings.map((warning) => warning.message)).toEqual([
    "fee: pay moves money from payer: actor to payee: operator. When the company runs create itself, actor is the company and it pays itself.",
  ]);
});
