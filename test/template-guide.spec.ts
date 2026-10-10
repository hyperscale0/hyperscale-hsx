import { expect, test } from "bun:test";
import { genericAdapter } from "../../adl/src/boundary-fixture.ts";
import { templateGuide, templateIndex } from "../src/template-guide.ts";

const options = {
  adapterRegistry: {
    conformance_boundary: {
      adapter: genericAdapter,
      operation: "boundary.observe",
    },
  },
};

// Mutation: drop an attach from catalog-program.ts, or expose an action its
// bindings exclude. That template's guide throws instead of answering.
test("every template's guide compiles its own example", () => {
  const index = templateIndex();
  expect(index.length).toBeGreaterThan(30);
  // Claude Code moves a tool result over 50,000 characters out of reach.
  expect(JSON.stringify(index).length).toBeLessThan(8_000);
  for (const { qualifiedName } of index) {
    const guide = templateGuide(qualifiedName, options);
    expect(guide?.qualifiedName).toBe(qualifiedName);
    expect(JSON.stringify(guide).length).toBeLessThan(50_000);
    expect(guide!.example).toContain(`= ${qualifiedName} {`);
  }
  expect(templateGuide("money.nothing", options)).toBeUndefined();
  expect(templateGuide("money", options)).toBeUndefined();
});

// Round 4 F9 and D4: an agent read amount as one piece and could not tell
// when the first piece is charged. Round 8 F4: a monthly plan is one line.
test("money.schedule says what amount means in each form, who runs each action and when a piece is charged", () => {
  const guide = templateGuide("money.schedule", options)!;
  expect(JSON.stringify(guide).length).toBeLessThan(8_000);
  const tunable = (name: string) =>
    guide.tunables.find((entry) => entry.name === name)!.meaning;
  expect(tunable("amount")).toContain(
    "occurrence.base: money = divide(self.schedule.amount, count)",
  );
  expect(tunable("amount")).toContain(
    "occurrence.amount: money = self.schedule.amount",
  );
  expect(tunable("every")).toContain(
    "occurrence.dueAt: date = after(self.schedule.startsAt, every, self.offset)",
  );
  expect(tunable("payer")).toBe(
    "Runs activate, cancel. Pays in occurrence.pay.",
  );
  expect(tunable("payee")).toBe(
    "Runs create, stop. Receives in occurrence.pay.",
  );
  const action = (name: string) =>
    guide.actions.find((entry) => entry.name === name)!;
  expect(action("create").invokes).toEqual([
    "occurrence.create, count times, when every is unset",
    "occurrence.create, when every is set",
  ]);
  // A rule under a branch names it, so a date list never reads as needing startsAt.
  expect(action("create").requires).toEqual([
    "self.startsAt >= self.now, when every is set",
  ]);
  expect(action("occurrence.pay")).toMatchObject({
    runBy: "clock",
    due: "self.dueAt",
    moves: ["self.amount from payer to payee"],
    invokes: [
      "occurrence.create, when every is set and count is set",
      "occurrence.create, when every is set and count is unset",
    ],
    when: "The clock runs it at self.dueAt. While self.schedule in [active] does not hold, it waits. activate collects every one already due in the same request.",
  });
  // The catalog example is the monthly form, so create takes the start date.
  expect(guide.createInput).toEqual([{ name: "startsAt", type: "date" }]);
  expect(guide.example).toContain("every: 1 month");
  expect(guide.example).toContain("expose activate");
  expect(guide.example).not.toContain("expose occurrence");
});

test("an escrow guide names the subject fields and keeps deadline offsets", () => {
  const guide = templateGuide("escrow.hold", options)!;
  expect(guide.subject.map((field) => field.name)).toContain("price");
  expect(
    guide.actions.find((action) => action.name === "accept")?.deadline,
  ).toBe("self.deliveredAt + accept_within");
  expect(guide.example).not.toContain("financing");
});
